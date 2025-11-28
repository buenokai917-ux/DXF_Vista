import React, { useState, useRef, useEffect, useMemo } from 'react';
import { jsPDF } from 'jspdf';
import { parseDxf } from './utils/dxfParser';
import { DxfData, LayerColors, DxfEntity, EntityType, Point, Bounds, SearchResult, ViewportRegion } from './types';
import { getBeamProperties, getCenter, transformPoint, findParallelPolygons, calculateLength, calculateTotalBounds, groupEntitiesByProximity, findTitleForBounds, getEntityBounds, parseViewportTitle, getGridIntersections, calculateMergeVector } from './utils/geometryUtils';
import { Viewer } from './components/Viewer';
import { Button } from './components/Button';
import { renderDxfToCanvas } from './utils/renderUtils';
import { Upload, Layers, Download, Image as ImageIcon, FileText, Settings, X, RefreshCw, Globe, Search, Calculator, Square, Box, Plus, File as FileIcon, Grid, ChevronUp, ChevronDown, GitMerge } from 'lucide-react';

// Standard CAD Colors (Index 1-7 + Grays + Common)
const CAD_COLORS = [
  '#FF0000', // Red
  '#FFFF00', // Yellow
  '#00FF00', // Green
  '#00FFFF', // Cyan
  '#0000FF', // Blue
  '#FF00FF', // Magenta
  '#FFFFFF', // White
  '#808080', // Gray
  '#C0C0C0', // Light Gray
  '#FFA500', // Orange
  '#A52A2A', // Brown
  '#800080', // Purple
];

interface ProjectFile {
  id: string;
  name: string;
  data: DxfData;
  activeLayers: Set<string>;
  filledLayers: Set<string>;
  splitRegions: ViewportRegion[] | null;
}

const App: React.FC = () => {
  const [projects, setProjects] = useState<ProjectFile[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [encoding, setEncoding] = useState<string>('gbk');
  const [layerColors, setLayerColors] = useState<LayerColors>({});
  const [layerSearchTerm, setLayerSearchTerm] = useState('');
  const [isSidebarOpen, setSidebarOpen] = useState(true);
  const [isLoading, setIsLoading] = useState(false);
  const [pickingColorLayer, setPickingColorLayer] = useState<string | null>(null);
  
  // Search State
  const [searchText, setSearchText] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [currentResultIdx, setCurrentResultIdx] = useState(-1);
  
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const activeProject = useMemo(() => 
    projects.find(p => p.id === activeProjectId) || null
  , [projects, activeProjectId]);

  const ENCODINGS = [
    { label: 'UTF-8 (Default)', value: 'utf-8' },
    { label: 'GBK (Chinese)', value: 'gbk' },
    { label: 'Big5 (Trad. Chinese)', value: 'big5' },
    { label: 'Shift_JIS (Japanese)', value: 'shift_jis' },
    { label: 'Windows-1252 (Latin)', value: 'windows-1252' },
  ];

  const handleFileUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const uploadedFiles = event.target.files;
    if (!uploadedFiles || uploadedFiles.length === 0) return;
    
    setIsLoading(true);
    
    // Process files
    const fileList = Array.from(uploadedFiles) as File[];
    
    const processFiles = async () => {
      const newProjects: ProjectFile[] = [];
      const newColors: LayerColors = { ...layerColors };
      const PALETTE = [
          '#0000FF', // Blue
          '#FF00FF', // Magenta (Pink)
          '#FFFF00', // Yellow
          '#00FF00', // Green
          '#00FFFF', // Cyan
          '#FFA500', // Orange
          '#9333EA', // Purple
      ];

      try {
        await Promise.all(fileList.map(async (file) => {
           const reader = new FileReader();
           const content = await new Promise<string>((resolve, reject) => {
              reader.onload = (e) => resolve(e.target?.result as string);
              reader.onerror = reject;
              reader.readAsText(file, encoding);
           });

           const parsed = parseDxf(content, encoding);
           
           // Determine colors for new layers
           parsed.layers.forEach((layer) => {
              if (newColors[layer]) return; // Skip if already colored

              const lower = layer.toLowerCase();
              // Rule 1: Text, Signature, Frame -> White
              if (lower.includes('text') || layer.includes('签名') || layer.includes('签字') || layer.includes('图框')) {
                newColors[layer] = '#FFFFFF';
                return;
              }
              // Rule 2: Exact AXIS -> Red
              if (layer === 'AXIS') {
                newColors[layer] = '#FF0000';
                return;
              }
              // Rule 3: Starts with AXIS -> Green
              if (layer.startsWith('AXIS')) {
                newColors[layer] = '#00FF00';
                return;
              }
              // Rule 4: Others -> Cycle
              let hash = 0;
              for (let i = 0; i < layer.length; i++) {
                hash = layer.charCodeAt(i) + ((hash << 5) - hash);
              }
              const colorIndex = Math.abs(hash) % PALETTE.length;
              newColors[layer] = PALETTE[colorIndex];
           });

           newProjects.push({
             id: Math.random().toString(36).substr(2, 9),
             name: file.name,
             data: parsed,
             activeLayers: new Set(parsed.layers),
             filledLayers: new Set(),
             splitRegions: null
           });
        }));

        setLayerColors(newColors);
        setProjects(prev => {
            const updated = [...prev, ...newProjects];
            // If no active project, set the first new one as active
            if (!activeProjectId && newProjects.length > 0) {
                setActiveProjectId(newProjects[0].id);
            }
            return updated;
        });

      } catch (err) {
        console.error(err);
        alert("Failed to read files.");
      } finally {
        setIsLoading(false);
      }
    };

    processFiles();
  };

  const toggleLayer = (layer: string) => {
    if (!activeProject) return;
    const newActive = new Set(activeProject.activeLayers);
    if (newActive.has(layer)) {
      newActive.delete(layer);
    } else {
      newActive.add(layer);
    }
    
    setProjects(prev => prev.map(p => 
      p.id === activeProject.id ? { ...p, activeLayers: newActive } : p
    ));
  };

  const toggleAllLayers = () => {
    if (!activeProject) return;
    const allLayers = activeProject.data.layers;
    const isFull = activeProject.activeLayers.size === allLayers.length;
    
    setProjects(prev => prev.map(p => 
      p.id === activeProject.id ? { ...p, activeLayers: isFull ? new Set() : new Set(allLayers) } : p
    ));
  };

  const handleColorChange = (layer: string, newColor: string) => {
    setLayerColors(prev => ({
      ...prev,
      [layer]: newColor
    }));
  };

  const filteredLayers = useMemo(() => {
    if (!activeProject) return [];
    if (!layerSearchTerm) return activeProject.data.layers;
    return activeProject.data.layers.filter(l => l.toLowerCase().includes(layerSearchTerm.toLowerCase()));
  }, [activeProject, layerSearchTerm]);

  // Recursively extract entities from layers, transforming block coordinates to world space
  const extractEntities = (targetLayers: string[], rootEntities: DxfEntity[], blocks: Record<string, DxfEntity[]>, blockBasePoints: Record<string, Point>): DxfEntity[] => {
      const extracted: DxfEntity[] = [];
      const recurse = (entities: DxfEntity[], transform: { scale: Point, rotation: number, translation: Point }) => {
          entities.forEach(ent => {
             // 1. Recursion into Blocks
             if (ent.type === EntityType.INSERT && ent.blockName && blocks[ent.blockName]) {
                 const basePoint = blockBasePoints[ent.blockName] || { x: 0, y: 0 };
                 
                 // Handle MINSERT (rows/cols)
                 const rows = ent.rowCount || 1;
                 const cols = ent.columnCount || 1;
                 const rSpace = ent.rowSpacing || 0;
                 const cSpace = ent.columnSpacing || 0;
                 
                 const baseScaleX = transform.scale.x * (ent.scale?.x || 1);
                 const baseScaleY = transform.scale.y * (ent.scale?.y || 1);
                 const baseRotation = transform.rotation + (ent.rotation || 0);

                 for (let r = 0; r < rows; r++) {
                     for (let c = 0; c < cols; c++) {
                         let gridX = c * cSpace;
                         let gridY = r * rSpace;
                         let rotGridX = gridX;
                         let rotGridY = gridY;

                         if (ent.rotation) {
                            const rad = ent.rotation * Math.PI / 180;
                            rotGridX = gridX * Math.cos(rad) - gridY * Math.sin(rad);
                            rotGridY = gridX * Math.sin(rad) + gridY * Math.cos(rad);
                         }

                         const localInsX = (ent.start?.x || 0) + rotGridX;
                         const localInsY = (ent.start?.y || 0) + rotGridY;
                         const tPos = transformPoint({x: localInsX, y: localInsY}, transform.scale, transform.rotation, transform.translation);
                         const tBase = transformPoint(basePoint, {x: baseScaleX, y: baseScaleY}, baseRotation, {x:0, y:0});
                         
                         const finalTrans = {
                             x: tPos.x - tBase.x,
                             y: tPos.y - tBase.y
                         };

                         recurse(blocks[ent.blockName!], {
                            scale: { x: baseScaleX, y: baseScaleY },
                            rotation: baseRotation,
                            translation: finalTrans
                         });
                     }
                 }
                 return;
             }
             // 2. Collection of Target Entities
             if (targetLayers.includes(ent.layer)) {
                 const worldEnt = { ...ent };
                 if (worldEnt.start) worldEnt.start = transformPoint(worldEnt.start, transform.scale, transform.rotation, transform.translation);
                 if (worldEnt.end) worldEnt.end = transformPoint(worldEnt.end, transform.scale, transform.rotation, transform.translation);
                 if (worldEnt.center) worldEnt.center = transformPoint(worldEnt.center, transform.scale, transform.rotation, transform.translation);
                 if (worldEnt.vertices) {
                     worldEnt.vertices = worldEnt.vertices.map(v => transformPoint(v, transform.scale, transform.rotation, transform.translation));
                 }
                 if (worldEnt.startAngle !== undefined) worldEnt.startAngle += transform.rotation;
                 if (worldEnt.endAngle !== undefined) worldEnt.endAngle += transform.rotation;
                 extracted.push(worldEnt);
             }
          });
      };
      recurse(rootEntities, { scale: {x:1, y:1}, rotation: 0, translation: {x:0, y:0} });
      return extracted;
  };

  const findEntitiesInAllProjects = (layerNamePattern: RegExp): DxfEntity[] => {
      let results: DxfEntity[] = [];
      projects.forEach(p => {
          const matchingLayers = p.data.layers.filter(l => layerNamePattern.test(l));
          if (matchingLayers.length > 0) {
              results = results.concat(extractEntities(matchingLayers, p.data.entities, p.data.blocks, p.data.blockBasePoints));
          }
      });
      return results;
  };

  // --- SEARCH FUNCTIONS ---

  const handleSearchChange = (e: React.ChangeEvent<HTMLInputElement>) => {
      setSearchText(e.target.value);
      // If user clears input, clear results
      if (!e.target.value) {
          handleClearSearch();
      }
  };

  const handleClearSearch = () => {
      setSearchText('');
      setSearchResults([]);
      setCurrentResultIdx(-1);
  };

  const performTextSearch = () => {
      if (!activeProject || !searchText.trim()) return;
      
      setIsLoading(true);
      setTimeout(() => {
          // Search ALL layers in the active project
          const allEntities = extractEntities(activeProject.data.layers, activeProject.data.entities, activeProject.data.blocks, activeProject.data.blockBasePoints);
          
          const query = searchText.toLowerCase();
          const matches: SearchResult[] = [];

          allEntities.forEach(ent => {
              if (ent.type === EntityType.TEXT || ent.type === EntityType.ATTRIB) { 
                   if (ent.text && ent.text.toLowerCase().includes(query)) {
                       const bounds = getEntityBounds(ent);
                       if (bounds) {
                           matches.push({
                               bounds,
                               rotation: ent.startAngle || 0
                           });
                       }
                   }
              }
          });

          // Sort matches top-left to bottom-right for consistent navigation
          matches.sort((a, b) => {
              // Group by rough Y position (lines), then X
              const rowA = Math.floor(a.bounds.minY / 1000);
              const rowB = Math.floor(b.bounds.minY / 1000);
              if (rowA !== rowB) return rowB - rowA; // Top to bottom (higher Y is top in CAD typically)
              return a.bounds.minX - b.bounds.minX; // Left to right
          });

          setSearchResults(matches);
          setCurrentResultIdx(matches.length > 0 ? 0 : -1);
          setIsLoading(false);

          if (matches.length === 0) {
              alert("No matches found.");
          }
      }, 50);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
          if (searchResults.length > 0) {
              handleNextResult();
          } else {
              performTextSearch();
          }
      }
  };

  const handleNextResult = () => {
      if (searchResults.length === 0) return;
      setCurrentResultIdx(prev => (prev + 1) % searchResults.length);
  };

  const handlePrevResult = () => {
      if (searchResults.length === 0) return;
      setCurrentResultIdx(prev => (prev - 1 + searchResults.length) % searchResults.length);
  };


  const calculateBeams = () => {
    if (!activeProject) return;

    const currentData = activeProject.data;
    const beamTextLayers = currentData.layers.filter(l => l.includes('梁筋'));
    const beamLayers = ['BEAM', 'BEAM_CON'];
    const entities = extractEntities(beamLayers, currentData.entities, currentData.blocks, currentData.blockBasePoints);
    
    // Include calculated layers (WALL_CALC, COLU_CALC) in obstacles to ensure splitting happens against the "clean" geometry if it exists.
    let obstacles = extractEntities(['WALL', 'COLU', 'COLUMN', 'WALL_CALC', 'COLU_CALC'], currentData.entities, currentData.blocks, currentData.blockBasePoints);
    if (obstacles.length < 10) {
         obstacles = findEntitiesInAllProjects(/wall|colu|column|柱|墙/i);
    }

    let axisEntities = extractEntities(['AXIS'], currentData.entities, currentData.blocks, currentData.blockBasePoints).filter(e => e.type === EntityType.LINE);
    if (axisEntities.length === 0) {
        axisEntities = findEntitiesInAllProjects(/^AXIS$/i).filter(e => e.type === EntityType.LINE);
    }
    
    let textEntities = extractEntities(beamTextLayers, currentData.entities, currentData.blocks, currentData.blockBasePoints).filter(e => e.type === EntityType.TEXT);
    if (textEntities.length === 0) {
        textEntities = findEntitiesInAllProjects(/梁筋/).filter(e => e.type === EntityType.TEXT);
    }

    // --- NEW LOGIC: Extract Valid Beam Widths from Text ---
    const validWidths = new Set<number>();
    textEntities.forEach(t => {
        if (!t.text) return;
        const matches = t.text.match(/(\d+)[xX×]\d+/);
        if (matches) {
            const w = parseInt(matches[1], 10);
            if (!isNaN(w) && w > 0) {
                validWidths.add(w);
            }
        }
    });
    
    const foundWidthsArray = Array.from(validWidths).sort((a,b) => a-b);
    
    const resultLayer = 'BEAM_CALC';
    const contextLayers = ['WALL', 'COLU', 'AXIS', ...beamTextLayers];

    const newEntities: DxfEntity[] = [];
    const lines = entities.filter(e => e.type === EntityType.LINE);
    const polylines = entities.filter(e => e.type === EntityType.LWPOLYLINE && e.closed);

    // Pass validWidths to the algorithm
    const generatedPolygons = findParallelPolygons(lines, 1200, resultLayer, obstacles, axisEntities, textEntities, 'BEAM', validWidths);
    const existingPolygons = polylines.map(p => ({ ...p, layer: resultLayer }));

    const allBeams = [...generatedPolygons, ...existingPolygons];

    allBeams.forEach(ent => {
        const props = getBeamProperties(ent);
        if (props.length > 500) {
            newEntities.push(ent);
            const center = getCenter(ent);
            if (center) {
                newEntities.push({
                    type: EntityType.TEXT,
                    layer: resultLayer,
                    start: center,
                    text: `L=${Math.round(props.length)}`,
                    radius: 250,
                    startAngle: props.angle % 180 === 0 ? 0 : props.angle
                });
            }
        }
    });

    if (newEntities.length === 0) {
        alert("No calculable beams found. (Note: Valid beams require pairs of lines matching text annotations like '200x500').");
        return;
    }

    // ENABLE FILL for beams
    updateActiveProjectData(resultLayer, newEntities, '#00FF00', contextLayers, true);
    
    let msg = `Calculated ${allBeams.length} beam segments.`;
    if (validWidths.size > 0) {
        msg += `\nUsed widths: ${foundWidthsArray.join(', ')}`;
    }
    alert(msg);
  };

  const calculateWalls = () => {
    if (!activeProject) return;
    
    const targetLayers = activeProject.data.layers.filter(l => /wall|墙/i.test(l));
    const columnObstacles = findEntitiesInAllProjects(/colu|column|柱/i);

    // EXTRACT AXIS ENTITIES & EXPLODE POLYLINES
    const rawAxisEntities = extractEntities(['AXIS'], activeProject.data.entities, activeProject.data.blocks, activeProject.data.blockBasePoints);
    const axisLines: DxfEntity[] = [];
    
    rawAxisEntities.forEach(ent => {
        if (ent.type === EntityType.LINE && ent.start && ent.end) {
            axisLines.push(ent);
        } else if (ent.type === EntityType.LWPOLYLINE && ent.vertices && ent.vertices.length > 1) {
            const verts = ent.vertices;
            for (let i = 0; i < verts.length - 1; i++) {
                axisLines.push({ type: EntityType.LINE, layer: ent.layer, start: verts[i], end: verts[i+1] });
            }
            if (ent.closed && verts.length > 2) {
                axisLines.push({ type: EntityType.LINE, layer: ent.layer, start: verts[verts.length-1], end: verts[0] });
            }
        }
    });
    
    if (axisLines.length === 0) {
        const otherAxis = findEntitiesInAllProjects(/^AXIS$/i);
        otherAxis.forEach(ent => {
             if (ent.type === EntityType.LINE) axisLines.push(ent);
        });
    }

    const resultLayer = 'WALL_CALC';
    const contextLayers = ['AXIS', 'COLU', 'BEAM_CALC'];

    const rawWallEntities = extractEntities(targetLayers, activeProject.data.entities, activeProject.data.blocks, activeProject.data.blockBasePoints);
    
    const candidateLines: DxfEntity[] = [];
    const existingClosedPolygons: DxfEntity[] = [];

    rawWallEntities.forEach(ent => {
        // PRESERVE EXISTING CLOSED SHAPES (e.g. Irregular Core Walls, C-shapes)
        if (ent.type === EntityType.LWPOLYLINE && ent.closed && ent.vertices && ent.vertices.length > 2) {
             existingClosedPolygons.push({ ...ent, layer: resultLayer });
        } else {
             if (ent.type === EntityType.LINE && ent.start && ent.end) {
                 candidateLines.push(ent);
             } else if (ent.type === EntityType.LWPOLYLINE && ent.vertices && ent.vertices.length > 1) {
                const verts = ent.vertices;
                for (let i = 0; i < verts.length; i++) {
                    if (ent.closed && i === verts.length - 1) {
                         const p1 = verts[i];
                         const p2 = verts[0];
                         candidateLines.push({ type: EntityType.LINE, layer: ent.layer, start: p1, end: p2 });
                    } else if (i < verts.length - 1) {
                        const p1 = verts[i];
                        const p2 = verts[i + 1];
                        candidateLines.push({ type: EntityType.LINE, layer: ent.layer, start: p1, end: p2 });
                    }
                }
             }
        }
    });

    const allObstacles = [...columnObstacles, ...rawWallEntities];

    const generatedWalls = findParallelPolygons(candidateLines, 600, resultLayer, allObstacles, axisLines, [], 'WALL');
    
    const newEntities: DxfEntity[] = [...generatedWalls, ...existingClosedPolygons];

    if (newEntities.length === 0) {
        alert("No valid wall segments found (Must have corresponding Axis line).");
        return;
    }

    // Auto-fill walls to merge overlaps visually
    updateActiveProjectData(resultLayer, newEntities, '#94a3b8', contextLayers, true); 
    alert(`Marked ${newEntities.length} wall segments.`);
  };

  const calculateColumns = () => {
    if (!activeProject) return;

    const targetLayers = activeProject.data.layers.filter(l => /colu|column|柱/i.test(l));
    const resultLayer = 'COLU_CALC';
    const contextLayers = ['AXIS', 'WALL_CALC', 'BEAM_CALC'];

    const rawEntities = extractEntities(targetLayers, activeProject.data.entities, activeProject.data.blocks, activeProject.data.blockBasePoints);

    const columnEntities = rawEntities.filter(e => 
        (e.type === EntityType.LWPOLYLINE && e.closed) ||
        e.type === EntityType.CIRCLE ||
        e.type === EntityType.INSERT
    ).map(e => ({...e, layer: resultLayer}));

    if (columnEntities.length === 0) {
        alert("No valid column objects found on column layers.");
        return;
    }

    // ENABLE FILL for columns
    updateActiveProjectData(resultLayer, columnEntities, '#f59e0b', contextLayers, true);
    alert(`Marked ${columnEntities.length} columns.`);
  };

  const calculateSplitRegions = (suppressAlert = false): ViewportRegion[] | null => {
      if (!activeProject) return null;
      const resultLayer = 'VIEWPORT_CALC';
      const debugLayer = 'VIEWPORT_DEBUG';

      // 1. Extract AXIS lines for clustering
      const axisLayers = activeProject.data.layers.filter(l => l.toUpperCase().includes('AXIS'));
      const axisLines = extractEntities(axisLayers, activeProject.data.entities, activeProject.data.blocks, activeProject.data.blockBasePoints)
          .filter(e => e.type === EntityType.LINE || e.type === EntityType.LWPOLYLINE);

      if (axisLines.length === 0) {
          if (!suppressAlert) alert("No AXIS lines found to determine regions.");
          return null;
      }

      // 2. Extract potential title Text and Lines
      const allText = extractEntities(activeProject.data.layers, activeProject.data.entities, activeProject.data.blocks, activeProject.data.blockBasePoints)
          .filter(e => e.type === EntityType.TEXT);
      
      const allLines = extractEntities(activeProject.data.layers, activeProject.data.entities, activeProject.data.blocks, activeProject.data.blockBasePoints)
          .filter(e => e.type === EntityType.LINE || e.type === EntityType.LWPOLYLINE);

      // 3. Cluster Axis lines
      const clusters = groupEntitiesByProximity(axisLines, 5000); // 5000mm tolerance for grouping
      
      const newEntities: DxfEntity[] = [];
      const debugEntities: DxfEntity[] = [];
      const regions: ViewportRegion[] = [];

      clusters.forEach((box, i) => {
          // Find Title
          const { title, scannedBounds } = findTitleForBounds(box, allText, allLines);
          const label = title || `BLOCK ${i + 1}`;

          // Save Region Data
          regions.push({
              bounds: box,
              title: label,
              info: parseViewportTitle(label)
          });

          // Create Rectangle
          const rect: DxfEntity = {
              type: EntityType.LWPOLYLINE,
              layer: resultLayer,
              closed: true,
              vertices: [
                  { x: box.minX, y: box.minY },
                  { x: box.maxX, y: box.minY },
                  { x: box.maxX, y: box.maxY },
                  { x: box.minX, y: box.maxY }
              ]
          };
          newEntities.push(rect);

          // Create Label Text (Top Left corner of box)
          newEntities.push({
              type: EntityType.TEXT,
              layer: resultLayer,
              text: label,
              start: { x: box.minX, y: box.maxY + 500 },
              radius: 1000 // Large text
          });

          // Create Debug Rings
          scannedBounds.forEach(sb => {
              debugEntities.push({
                  type: EntityType.LWPOLYLINE,
                  layer: debugLayer,
                  closed: true,
                  vertices: [
                      { x: sb.minX, y: sb.minY },
                      { x: sb.maxX, y: sb.minY },
                      { x: sb.maxX, y: sb.maxY },
                      { x: sb.minX, y: sb.maxY }
                  ]
              });
          });
      });

      if (newEntities.length === 0) {
          if (!suppressAlert) alert("Could not determine split regions.");
          return null;
      }

      // Persist regions and add visualization layers
      const updatedData = {
          ...activeProject.data,
          entities: [...activeProject.data.entities, ...newEntities, ...debugEntities],
          layers: [...new Set([...activeProject.data.layers, resultLayer, debugLayer])]
      };

      const newColors = { ...layerColors, [resultLayer]: '#FF00FF', [debugLayer]: '#444444' };
      setLayerColors(newColors);

      setProjects(prev => prev.map(p => {
          if (p.id === activeProject.id) {
               const newActive = new Set(p.activeLayers);
               newActive.add(resultLayer);
               // Do not activate debug layer by default
               return { ...p, data: updatedData, splitRegions: regions, activeLayers: newActive };
          }
          return p;
      }));

      if (!suppressAlert) alert(`Found ${clusters.length} regions.`);
      return regions;
  };

  const handleMergeViews = () => {
      if (!activeProject) return;
      
      let regions = activeProject.splitRegions;
      
      // If regions not calculated yet, calculate them first
      if (!regions || regions.length === 0) {
          regions = calculateSplitRegions(true); // Suppress alert for implicit split
      }

      if (!regions || regions.length === 0) {
          alert("Could not identify regions to merge.");
          return;
      }
      
      const resultLayer = 'MERGE_RESULT';
      const axisLayers = activeProject.data.layers.filter(l => l.toUpperCase().includes('AXIS'));
      const axisLines = extractEntities(axisLayers, activeProject.data.entities, activeProject.data.blocks, activeProject.data.blockBasePoints)
          .filter(e => e.type === EntityType.LINE || e.type === EntityType.LWPOLYLINE);

      // Group by prefix
      const groups: Record<string, ViewportRegion[]> = {};
      regions.forEach(r => {
          if (r.info) {
              const key = r.info.prefix;
              if (!groups[key]) groups[key] = [];
              groups[key].push(r);
          }
      });

      const mergedEntities: DxfEntity[] = [];
      const allEntities = extractEntities(activeProject.data.layers, activeProject.data.entities, activeProject.data.blocks, activeProject.data.blockBasePoints);

      let mergedCount = 0;

      Object.entries(groups).forEach(([prefix, views]) => {
          if (views.length < 2) return;
          
          views.sort((a, b) => a.info!.index - b.info!.index);
          const baseView = views[0]; // Index 1
          
          const baseIntersections = getGridIntersections(baseView.bounds, axisLines);

          for (let i = 1; i < views.length; i++) {
              const targetView = views[i];
              const targetIntersections = getGridIntersections(targetView.bounds, axisLines);
              
              const vec = calculateMergeVector(baseIntersections, targetIntersections);
              
              if (vec) {
                  // Find entities inside target bounds
                  allEntities.forEach(ent => {
                      const b = getEntityBounds(ent);
                      if (!b) return;
                      // Check center is in target bounds
                      const cx = (b.minX + b.maxX)/2;
                      const cy = (b.minY + b.maxY)/2;
                      
                      if (cx >= targetView.bounds.minX && cx <= targetView.bounds.maxX &&
                          cy >= targetView.bounds.minY && cy <= targetView.bounds.maxY) {
                          
                          // Exclude Viewport Frames and Titles (heuristic)
                          if (ent.layer === 'VIEWPORT_CALC' || ent.layer === 'VIEWPORT_DEBUG') return;
                          
                          // Clone and Translate
                          const clone = { ...ent };
                          clone.layer = resultLayer;
                          
                          if (clone.start) clone.start = { x: clone.start.x + vec.x, y: clone.start.y + vec.y };
                          if (clone.end) clone.end = { x: clone.end.x + vec.x, y: clone.end.y + vec.y };
                          if (clone.center) clone.center = { x: clone.center.x + vec.x, y: clone.center.y + vec.y };
                          if (clone.vertices) clone.vertices = clone.vertices.map(v => ({ x: v.x + vec.x, y: v.y + vec.y }));
                          if (clone.measureStart) clone.measureStart = { x: clone.measureStart.x + vec.x, y: clone.measureStart.y + vec.y };
                          if (clone.measureEnd) clone.measureEnd = { x: clone.measureEnd.x + vec.x, y: clone.measureEnd.y + vec.y };

                          mergedEntities.push(clone);
                      }
                  });
                  mergedCount++;
              }
          }
      });

      if (mergedCount === 0) {
          alert("No mergeable views found or alignment failed.");
          return;
      }
      
      updateActiveProjectData(resultLayer, mergedEntities, '#FFFFFF', [], false);
      alert(`Merged ${mergedCount} views into '${resultLayer}'.`);
  };

  const updateActiveProjectData = (resultLayer: string, newEntities: DxfEntity[], color: string, contextLayers: string[], fillLayer: boolean) => {
      if (!activeProject) return;
      
      const updatedData = {
          ...activeProject.data,
          entities: [...activeProject.data.entities, ...newEntities],
          layers: activeProject.data.layers.includes(resultLayer) ? activeProject.data.layers : [resultLayer, ...activeProject.data.layers]
      };

      setLayerColors(prev => ({ ...prev, [resultLayer]: color }));

      setProjects(prev => prev.map(p => {
          if (p.id === activeProject.id) {
              const newActive = new Set(p.activeLayers);
              newActive.add(resultLayer);
              contextLayers.forEach(l => {
                  if (updatedData.layers.includes(l)) newActive.add(l);
              });
              
              const newFilled = new Set(p.filledLayers);
              if (fillLayer) {
                  newFilled.add(resultLayer);
              }

              return { ...p, data: updatedData, activeLayers: newActive, filledLayers: newFilled };
          }
          return p;
      }));
  };

  const generateExportCanvas = (): HTMLCanvasElement | null => {
      if (!activeProject) return null;

      const bounds = calculateTotalBounds(
          activeProject.data.entities, 
          activeProject.data.blocks, 
          activeProject.activeLayers
      );

      let dataWidth = bounds.maxX - bounds.minX;
      let dataHeight = bounds.maxY - bounds.minY;

      if (dataWidth <= 0 || dataHeight <= 0) {
          alert("Nothing to export (Drawing is empty or boundaries invalid).");
          return null;
      }

      const MAX_DIMENSION = 8192;
      const padding = dataWidth * 0.05; 
      
      const paddedWidth = dataWidth + padding * 2;
      const paddedHeight = dataHeight + padding * 2;
      
      let canvasWidth, canvasHeight, scale;
      
      if (paddedWidth > paddedHeight) {
          canvasWidth = MAX_DIMENSION;
          scale = MAX_DIMENSION / paddedWidth;
          canvasHeight = paddedHeight * scale;
      } else {
          canvasHeight = MAX_DIMENSION;
          scale = MAX_DIMENSION / paddedHeight;
          canvasWidth = paddedWidth * scale;
      }

      const offScreenCanvas = document.createElement('canvas');
      offScreenCanvas.width = canvasWidth;
      offScreenCanvas.height = canvasHeight;
      const ctx = offScreenCanvas.getContext('2d');

      if (!ctx) {
          alert("Failed to initialize export canvas.");
          return null;
      }

      const midX = bounds.minX + dataWidth / 2;
      const midY = bounds.minY + dataHeight / 2;
      
      const transform = {
          k: scale,
          x: (canvasWidth / 2) - midX * scale,
          y: (canvasHeight / 2) - midY * scale
      };

      renderDxfToCanvas({
          ctx,
          data: activeProject.data,
          activeLayers: activeProject.activeLayers,
          layerColors: layerColors,
          filledLayers: activeProject.filledLayers,
          transform,
          width: canvasWidth,
          height: canvasHeight,
          isPdfExport: true
      });
      
      return offScreenCanvas;
  };

  const exportPng = () => {
    setIsLoading(true);
    setTimeout(() => {
        const canvas = generateExportCanvas();
        if (canvas && activeProject) {
            const link = document.createElement('a');
            link.download = `${activeProject.name.replace('.dxf', '')}_full_export.png`;
            link.href = canvas.toDataURL('image/png'); 
            link.click();
        }
        setIsLoading(false);
    }, 100);
  };

  const exportPdf = () => {
    setIsLoading(true);
    setTimeout(() => {
        const canvas = generateExportCanvas();
        if (canvas && activeProject) {
             const imgData = canvas.toDataURL('image/png');
             const canvasWidth = canvas.width;
             const canvasHeight = canvas.height;
             const isLandscape = canvasWidth > canvasHeight;

             const pdf = new jsPDF({
               orientation: isLandscape ? 'l' : 'p',
               unit: 'mm',
               format: 'a4'
             });

             const pdfPageWidth = pdf.internal.pageSize.getWidth();
             const pdfPageHeight = pdf.internal.pageSize.getHeight();
             
             const ratio = canvasWidth / canvasHeight;
             let pdfImgWidth = pdfPageWidth;
             let pdfImgHeight = pdfImgWidth / ratio;
             
             if (pdfImgHeight > pdfPageHeight) {
                 pdfImgHeight = pdfPageHeight;
                 pdfImgWidth = pdfImgHeight * ratio;
             }

             const x = (pdfPageWidth - pdfImgWidth) / 2;
             const y = (pdfPageHeight - pdfImgHeight) / 2;

             pdf.addImage(imgData, 'PNG', x, y, pdfImgWidth, pdfImgHeight);
             pdf.save(`${activeProject.name.replace('.dxf', '')}_full_export.pdf`);
        }
        setIsLoading(false);
    }, 100);
  };

  const closeTab = (e: React.MouseEvent, id: string) => {
      e.stopPropagation();
      setProjects(prev => {
          const filtered = prev.filter(p => p.id !== id);
          if (activeProjectId === id) {
              setActiveProjectId(filtered.length > 0 ? filtered[filtered.length - 1].id : null);
          }
          return filtered;
      });
  };

  return (
    <div className="flex h-screen w-full overflow-hidden bg-slate-950 text-slate-100">
      
      {/* Sidebar */}
      <div 
        className={`${
          isSidebarOpen ? 'w-80' : 'w-0'
        } bg-slate-900 border-r border-slate-800 transition-all duration-300 flex flex-col relative shrink-0`}
      >
        <div className="p-4 border-b border-slate-800 flex justify-between items-center">
          <h1 className="font-bold text-xl flex items-center gap-2 text-blue-400">
            <Settings className="w-5 h-5" />
            DXF Vista
          </h1>
          <button onClick={() => setSidebarOpen(false)} className="md:hidden text-slate-400">
            <X size={20} />
          </button>
        </div>

        <div className="p-4 border-b border-slate-800 space-y-4">
           {/* Upload */}
           <label className="block w-full cursor-pointer group">
              <div className="flex flex-col items-center justify-center w-full h-16 border-2 border-slate-700 border-dashed rounded-lg bg-slate-800/50 hover:bg-slate-800 hover:border-blue-500 transition-all">
                  <div className="flex flex-col items-center justify-center pt-1 pb-1">
                      <Plus className="w-5 h-5 mb-1 text-slate-400 group-hover:text-blue-400" />
                      <p className="text-xs text-slate-400">Add DXF Files</p>
                  </div>
                  <input type="file" accept=".dxf" multiple className="hidden" onChange={handleFileUpload} />
              </div>
           </label>

           {/* Encoding Selector */}
           <div className="flex flex-col gap-2">
              <div className="flex justify-between items-center">
                  <label className="text-xs text-slate-500 font-medium flex items-center gap-1">
                    <Globe size={12} />
                    Text Encoding
                  </label>
                  <span className="text-[10px] text-slate-600">Apply to next upload</span>
              </div>
              <select 
                value={encoding} 
                onChange={(e) => setEncoding(e.target.value)}
                className="w-full bg-slate-800 text-xs text-slate-200 border border-slate-700 rounded px-2 py-2 focus:ring-1 focus:ring-blue-500 outline-none"
              >
                {ENCODINGS.map(enc => (
                  <option key={enc.value} value={enc.value}>{enc.label}</option>
                ))}
              </select>
           </div>
        </div>

        {/* Layer List Area */}
        <div className="flex-1 overflow-y-auto p-4 flex flex-col">
          <div className="flex items-center justify-between mb-2">
            <h2 className="text-sm font-semibold text-slate-400 uppercase tracking-wider flex items-center gap-2">
              <Layers size={14} /> Layers
            </h2>
            {activeProject && (
              <button onClick={toggleAllLayers} className="text-xs text-blue-400 hover:text-blue-300 flex items-center gap-1">
                <RefreshCw size={10} />
                {activeProject.activeLayers.size === activeProject.data.layers.length ? 'Hide All' : 'Show All'}
              </button>
            )}
          </div>

          {/* Layer Search */}
          {activeProject && (
            <div className="relative mb-3 shrink-0">
              <input 
                type="text" 
                placeholder="Filter layers..." 
                value={layerSearchTerm}
                onChange={(e) => setLayerSearchTerm(e.target.value)}
                className="w-full bg-slate-800 border border-slate-700 rounded px-3 py-1.5 pl-8 text-xs focus:ring-1 focus:ring-blue-500 outline-none"
              />
              <Search className="absolute left-2.5 top-1.5 text-slate-500 w-3.5 h-3.5" />
            </div>
          )}

          {isLoading ? (
            <div className="flex items-center justify-center py-8">
               <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-blue-500"></div>
            </div>
          ) : !activeProject ? (
            <div className="text-center text-slate-600 text-sm py-8 flex-1 flex flex-col items-center justify-center border-2 border-dashed border-slate-800 rounded">
              <FileIcon className="w-8 h-8 mb-2 opacity-50"/>
              No file selected
            </div>
          ) : (
            <div className="space-y-1 overflow-y-auto flex-1 pr-1">
              {filteredLayers.length === 0 && (
                <div className="text-xs text-slate-500 text-center py-4">No matching layers</div>
              )}
              {filteredLayers.map((layer) => (
                <div key={layer} className="flex flex-col">
                    <div 
                      className={`flex items-center p-2 rounded transition-colors group ${
                        activeProject.activeLayers.has(layer) ? 'bg-slate-800 text-slate-200' : 'text-slate-500 hover:bg-slate-800/50'
                      }`}
                    >
                      <div 
                        className="relative w-4 h-4 mr-3 shrink-0 cursor-pointer"
                        onClick={(e) => {
                           e.stopPropagation();
                           setPickingColorLayer(pickingColorLayer === layer ? null : layer);
                        }} 
                        title="Click to change color"
                      >
                         <div 
                            className="w-3 h-3 rounded-full absolute top-0.5 left-0.5 border border-slate-600 transition-all hover:scale-125" 
                            style={{ 
                              backgroundColor: layerColors[layer],
                              boxShadow: activeProject.activeLayers.has(layer) ? `0 0 6px ${layerColors[layer]}` : 'none',
                              opacity: activeProject.activeLayers.has(layer) ? 1 : 0.6
                            }}
                         ></div>
                      </div>
                      <span 
                        className="text-sm truncate select-none flex-1 cursor-pointer" 
                        title={layer}
                        onClick={() => toggleLayer(layer)}
                      >
                        {layer}
                      </span>
                    </div>

                    {/* Color Palette Accordion */}
                    {pickingColorLayer === layer && (
                       <div className="pl-9 pr-2 pb-3 pt-1 grid grid-cols-6 gap-2 bg-slate-900/50 rounded-b mb-2 animate-in fade-in slide-in-from-top-1 duration-200">
                           {CAD_COLORS.map(color => (
                               <button
                                 key={color}
                                 className="w-5 h-5 rounded-full border border-slate-600 hover:scale-110 hover:border-white transition-all ring-offset-1 ring-offset-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
                                 style={{ backgroundColor: color }}
                                 title={color}
                                 onClick={(e) => {
                                     e.stopPropagation();
                                     handleColorChange(layer, color);
                                     setPickingColorLayer(null);
                                 }}
                               />
                           ))}
                       </div>
                    )}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Action Buttons */}
        <div className="p-4 border-t border-slate-800 space-y-3 shrink-0 bg-slate-900 z-10">
            <p className="text-xs text-slate-500 font-medium mb-2">ANALYSIS (Active Tab)</p>
            <div className="grid grid-cols-2 gap-2">
                <Button 
                  onClick={calculateBeams} 
                  disabled={!activeProject || isLoading} 
                  variant="primary" 
                  className="w-full justify-center text-xs bg-green-600 hover:bg-green-700"
                  title="Calculate Beams using All Loaded Files"
                >
                  <Calculator size={14} className="mr-1"/> Beams
                </Button>
                <Button 
                  onClick={calculateColumns} 
                  disabled={!activeProject || isLoading} 
                  variant="primary" 
                  className="w-full justify-center text-xs bg-amber-600 hover:bg-amber-700"
                  title="Mark Columns"
                >
                  <Square size={14} className="mr-1"/> Columns
                </Button>
                <Button 
                  onClick={calculateWalls} 
                  disabled={!activeProject || isLoading} 
                  variant="primary" 
                  className="w-full justify-center text-xs bg-slate-600 hover:bg-slate-700"
                  title="Mark Walls"
                >
                  <Box size={14} className="mr-1"/> Walls
                </Button>
                
                {/* Search / Split Group */}
                <div className="col-span-2 space-y-2">
                    <div className="grid grid-cols-2 gap-2">
                        <Button 
                          onClick={() => calculateSplitRegions()} 
                          disabled={!activeProject || isLoading} 
                          variant="primary" 
                          className="w-full justify-center text-xs bg-purple-600 hover:bg-purple-700"
                          title="Split View / Identify Blocks"
                        >
                          <Grid size={14} className="mr-1"/> Split View
                        </Button>
                        <Button 
                          onClick={handleMergeViews} 
                          disabled={!activeProject || isLoading} 
                          variant="primary" 
                          className="w-full justify-center text-xs bg-indigo-600 hover:bg-indigo-700"
                          title="Merge Split Views"
                        >
                          <GitMerge size={14} className="mr-1"/> Merge Views
                        </Button>
                    </div>
                </div>

                <div className="col-span-2">
                   <p className="text-[10px] text-slate-500 mb-1">GLOBAL TEXT SEARCH</p>
                   <div className="flex items-center gap-1">
                       <div className="relative flex-1">
                           <input 
                              type="text"
                              value={searchText}
                              onChange={handleSearchChange}
                              onKeyDown={handleKeyDown}
                              placeholder="Search text..."
                              className="w-full bg-slate-800 border border-slate-700 rounded px-2 py-1 text-xs focus:ring-1 focus:ring-blue-500 outline-none pr-6"
                           />
                           {searchResults.length > 0 ? (
                               <span className="absolute right-7 top-1.5 text-[10px] text-slate-400">
                                   {currentResultIdx + 1}/{searchResults.length}
                               </span>
                           ) : searchText && (
                               <button 
                                 onClick={handleClearSearch}
                                 className="absolute right-1 top-1 p-0.5 text-slate-400 hover:text-white"
                               >
                                 <X size={12} />
                               </button>
                           )}
                           {searchResults.length > 0 && (
                               <button 
                                 onClick={handleClearSearch}
                                 className="absolute right-1 top-1 p-0.5 text-slate-400 hover:text-white"
                               >
                                 <X size={12} />
                               </button>
                           )}
                       </div>
                       <button onClick={handlePrevResult} disabled={searchResults.length === 0} className="p-1 bg-slate-800 rounded hover:bg-slate-700 disabled:opacity-30">
                           <ChevronUp size={14} />
                       </button>
                       <button onClick={handleNextResult} disabled={searchResults.length === 0} className="p-1 bg-slate-800 rounded hover:bg-slate-700 disabled:opacity-30">
                           <ChevronDown size={14} />
                       </button>
                   </div>
                </div>
            </div>

            <div className="h-px bg-slate-800 my-2"></div>
            
            <p className="text-xs text-slate-500 font-medium mb-2">EXPORT (High Res)</p>
            <div className="flex gap-2">
              <Button 
                onClick={exportPdf} 
                disabled={!activeProject || isLoading} 
                variant="secondary" 
                className="flex-1 justify-center text-xs"
                title="Export High-Res PDF"
              >
                <FileText size={14} className="mr-1" /> PDF
              </Button>
              <Button 
                onClick={exportPng} 
                disabled={!activeProject || isLoading} 
                variant="secondary" 
                className="flex-1 justify-center text-xs"
                title="Export PNG"
              >
                <ImageIcon size={14} className="mr-1" /> PNG
              </Button>
            </div>
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 flex flex-col h-full relative bg-slate-950">
        
        {/* Top Tab Bar */}
        <div className="h-10 bg-slate-900 border-b border-slate-800 flex items-center px-2 gap-1 overflow-x-auto">
             {!isSidebarOpen && (
              <button 
                onClick={() => setSidebarOpen(true)}
                className="mr-2 p-1.5 rounded hover:bg-slate-800 text-slate-400"
              >
                <Layers size={18} />
              </button>
            )}
            
            {projects.map(p => (
                <div 
                  key={p.id}
                  onClick={() => setActiveProjectId(p.id)}
                  className={`
                    flex items-center gap-2 px-3 py-1.5 rounded-t-md text-xs cursor-pointer border-t border-x select-none min-w-[120px] max-w-[200px]
                    ${activeProjectId === p.id 
                       ? 'bg-slate-800 border-slate-700 text-white border-b-transparent translate-y-[1px]' 
                       : 'bg-slate-900 border-transparent text-slate-500 hover:bg-slate-800/50 hover:text-slate-300'}
                  `}
                >
                    <span className="truncate flex-1">{p.name}</span>
                    <button 
                      onClick={(e) => closeTab(e, p.id)} 
                      className="p-0.5 rounded-full hover:bg-slate-700 text-slate-500 hover:text-red-400"
                    >
                        <X size={12} />
                    </button>
                </div>
            ))}

            {projects.length === 0 && (
                 <div className="text-xs text-slate-600 px-4 italic">No files open</div>
            )}
        </div>

        {/* Viewer Area */}
        <div className="flex-1 relative overflow-hidden">
             <Viewer 
               data={activeProject ? activeProject.data : null} 
               activeLayers={activeProject ? activeProject.activeLayers : new Set()} 
               layerColors={layerColors}
               filledLayers={activeProject ? activeProject.filledLayers : new Set()}
               targetBounds={currentResultIdx >= 0 ? searchResults[currentResultIdx].bounds : null}
               highlights={searchResults}
               activeHighlightIndex={currentResultIdx}
               onRef={(ref) => canvasRef.current = ref} 
             />
             
             {/* Overlay Info */}
             {activeProject && !isLoading && (
                <div className="absolute top-4 right-4 bg-slate-900/90 border border-slate-700 rounded-lg p-3 text-xs text-slate-400 backdrop-blur-sm shadow-xl pointer-events-none">
                   <div className="grid grid-cols-2 gap-x-4 gap-y-1">
                     <span className="font-semibold text-slate-500">File:</span>
                     <span className="text-right text-slate-300 max-w-[150px] truncate">{activeProject.name}</span>
                     <span className="font-semibold">Entities:</span>
                     <span className="text-right text-slate-200">{activeProject.data.entities.length}</span>
                     <span className="font-semibold">Layers:</span>
                     <span className="text-right text-slate-200">{activeProject.data.layers.length}</span>
                   </div>
                </div>
             )}
        </div>
      </div>
    </div>
  );
};

export default App;