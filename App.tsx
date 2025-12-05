
import React, { useState, useRef, useEffect, useMemo } from 'react';
import { jsPDF } from 'jspdf';
import { parseDxf } from './utils/dxfParser';
import { DxfData, LayerColors, DxfEntity, EntityType, Point, Bounds, SearchResult, ViewportRegion, AnalysisDomain, ProjectFile, SemanticLayer } from './types';
import { calculateTotalBounds, getEntityBounds } from './utils/geometryUtils';
import { extractEntities } from './utils/dxfHelpers';
import { Viewer } from './components/Viewer';
import { Button } from './components/Button';
import { renderDxfToCanvas } from './utils/renderUtils';
import { AnalysisSidebar } from './components/AnalysisSidebar';
import { Layers, Image as ImageIcon, FileText, Settings, X, RefreshCw, Search, Plus, File as FileIcon, ChevronUp, ChevronDown, Hammer } from 'lucide-react';
import { getStoredConfig, saveStoredConfig } from './utils/configStorage';
import { getStoredAnalysis } from './utils/analysisStorage';
import { restoreSplitRegions, restoreMergedViews } from './domains/structure/views';
import { restoreColumns, restoreWalls } from './domains/structure/verticals';

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

type SidebarTab = 'LAYERS' | 'ANALYSIS';

const App: React.FC = () => {
  // --- STATE ---
  const [projects, setProjects] = useState<ProjectFile[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [layerColors, setLayerColors] = useState<LayerColors>({});
  const [layerSearchTerm, setLayerSearchTerm] = useState('');
  const [isSidebarOpen, setSidebarOpen] = useState(true);
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>('LAYERS');
  const [isLoading, setIsLoading] = useState(false);
  const [pickingColorLayer, setPickingColorLayer] = useState<string | null>(null);
  
  // Analysis State
  const [analysisDomain, setAnalysisDomain] = useState<AnalysisDomain>('STRUCTURE');

  // Picking State for Layer Configuration
  const [pickingTarget, setPickingTarget] = useState<SemanticLayer | null>(null);

  // Search State
  const [searchText, setSearchText] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [currentResultIdx, setCurrentResultIdx] = useState(-1);
  
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const activeProject = useMemo(() => 
    projects.find(p => p.id === activeProjectId) || null
  , [projects, activeProjectId]);

  // --- DATA LOADING ---

  const autoDetectLayers = (layers: string[], usedLayers: Set<string>): Record<SemanticLayer, string[]> => {
    const config: Record<SemanticLayer, string[]> = {
      [SemanticLayer.AXIS]: [],
      [SemanticLayer.COLUMN]: [],
      [SemanticLayer.WALL]: [],
      [SemanticLayer.BEAM]: [],
      [SemanticLayer.BEAM_LABEL]: [],
      [SemanticLayer.BEAM_IN_SITU_LABEL]: [],
      [SemanticLayer.VIEWPORT_TITLE]: []
    };

    layers.forEach(l => {
      // Filter out empty layers
      if (!usedLayers.has(l)) return;

      const lower = l.toLowerCase();
      
      // Filter out dsp3d/dsptext layers (usually 3D generated artifacts)
      if (lower.startsWith('dsp3d') || lower.includes('dsptext')) return;

      if (/axis|轴|grid/i.test(l)) config[SemanticLayer.AXIS].push(l);
      else if (/colu|column|柱/i.test(l)) config[SemanticLayer.COLUMN].push(l);
      else if (/wall|墙/i.test(l)) config[SemanticLayer.WALL].push(l);
      else if (/beam|梁/i.test(l) && !/text|dim|anno|标注|文字/i.test(l)) config[SemanticLayer.BEAM].push(l);
      
      // In-Situ Labels (Specific Reinforcement info)
      if (/原位标注|in[-_]?situ/i.test(l)) {
          config[SemanticLayer.BEAM_IN_SITU_LABEL].push(l);
      }
      // General Labels (Dimensions, Names)
      // Exclude "In-Situ" (原位标注) from general labels if possible, to keep them clean
      else if (/dim|anno|text|标注|文字|label/i.test(l)) {
          config[SemanticLayer.BEAM_LABEL].push(l);
      }
      
      // Viewport Titles: Added 'pub_text' as requested
      if (/title|name|图名|view|pub_text/i.test(l)) {
          config[SemanticLayer.VIEWPORT_TITLE].push(l);
      }
    });

    return config;
  };

  const handleFileUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const uploadedFiles = event.target.files;
    if (!uploadedFiles || uploadedFiles.length === 0) return;
    
    setIsLoading(true);
    
    // Process files
    const fileList = Array.from(uploadedFiles) as File[];

    // Try multiple encodings and pick the one with the fewest replacement chars ()
    const decodeBufferBestEffort = (buffer: ArrayBuffer) => {
      const preferred = ['utf-8', 'gb18030', 'gbk', 'big5', 'shift_jis', 'windows-1252'];
      const seen = new Set<string>();
      let best = { text: '', enc: 'utf-8', score: Number.POSITIVE_INFINITY };

      preferred.forEach(enc => {
        if (!enc || seen.has(enc)) return;
        seen.add(enc);
        try {
          const dec = new TextDecoder(enc as any, { fatal: false });
          const text = dec.decode(new Uint8Array(buffer));
          const score = (text.match(/\uFFFD/g) || []).length;
          if (score < best.score) {
            best = { text, enc, score };
          }
        } catch (e) {
          // Ignore unsupported encodings
        }
      });

      if (best.text === '') {
        best.text = new TextDecoder().decode(new Uint8Array(buffer));
        best.enc = 'utf-8';
      }

      return best;
    };
    
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
           const { text: content, enc: usedEnc } = await new Promise<{ text: string, enc: string }>((resolve, reject) => {
              reader.onload = (e) => {
                const result = e.target?.result;
                if (result instanceof ArrayBuffer) {
                  resolve(decodeBufferBestEffort(result));
                } else if (typeof result === 'string') {
                  resolve({ text: result, enc: 'utf-8' });
                } else {
                  resolve({ text: '', enc: 'utf-8' });
                }
              };
              reader.onerror = reject;
              reader.readAsArrayBuffer(file);
           });

           const parsed = parseDxf(content, usedEnc);
           
           // Determine used layers to filter out empty ones
           const usedLayers = new Set<string>();
           parsed.entities.forEach(e => usedLayers.add(e.layer));
           // Blocks also contain entities on layers
           Object.values(parsed.blocks).forEach(ents => ents.forEach(e => usedLayers.add(e.layer)));

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

           // PRIORITY: Check LocalStorage for existing config for this file
           const storedConfig = getStoredConfig(file.name);
           const detectedConfig = autoDetectLayers(parsed.layers, usedLayers);

           const project: ProjectFile = {
             id: Math.random().toString(36).substr(2, 9),
             name: file.name,
             data: parsed,
             activeLayers: new Set(parsed.layers),
             filledLayers: new Set(),
             layerConfig: storedConfig || detectedConfig, // Prefer stored
             splitRegions: null
           };

           newProjects.push(project);
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
        
        // Post-Load Restoration Effect
        setTimeout(() => {
            newProjects.forEach(p => {
                const savedAnalysis = getStoredAnalysis(p.name);
                if (savedAnalysis) {
                    if (savedAnalysis.splitRegions) {
                        restoreSplitRegions(p, savedAnalysis.splitRegions, setProjects, setLayerColors);
                    }
                    if (savedAnalysis.mergedViewData) {
                        restoreMergedViews(p, savedAnalysis.mergedViewData, setProjects, setLayerColors);
                    }
                    if (savedAnalysis.columns) {
                        restoreColumns(p, savedAnalysis.columns, setProjects, setLayerColors);
                    }
                    if (savedAnalysis.walls) {
                        restoreWalls(p, savedAnalysis.walls, setProjects, setLayerColors);
                    }
                }
            });
        }, 100);

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

  // --- PICKING LOGIC ---
  const handleLayerPick = (layer: string) => {
    if (!pickingTarget || !activeProject) return;
    
    setProjects(prev => prev.map(p => {
        if (p.id === activeProject.id) {
            const currentConfig = p.layerConfig[pickingTarget] || [];
            // Toggle layer in config
            const newConfigLayers = currentConfig.includes(layer) 
                ? currentConfig.filter(l => l !== layer)
                : [...currentConfig, layer];
            
            const fullConfig = {
                ...p.layerConfig,
                [pickingTarget]: newConfigLayers
            };

            // PERSISTENCE: Save to LocalStorage immediately
            saveStoredConfig(p.name, fullConfig);

            return {
                ...p,
                layerConfig: fullConfig
            };
        }
        return p;
    }));
    // Note: We do NOT clear pickingTarget here to allow multi-select. 
    // User must manually stop picking via Sidebar UI.
  };

  // --- SEARCH ---

  const handleSearchChange = (e: React.ChangeEvent<HTMLInputElement>) => {
      setSearchText(e.target.value);
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

          matches.sort((a, b) => {
              const rowA = Math.floor(a.bounds.minY / 1000);
              const rowB = Math.floor(b.bounds.minY / 1000);
              if (rowA !== rowB) return rowB - rowA; 
              return a.bounds.minX - b.bounds.minX;
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


  // --- EXPORT ---

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

  const filteredLayers = useMemo(() => {
    if (!activeProject) return [];
    if (!layerSearchTerm) return activeProject.data.layers;
    return activeProject.data.layers.filter(l => l.toLowerCase().includes(layerSearchTerm.toLowerCase()));
  }, [activeProject, layerSearchTerm]);

  return (
    <div className="flex h-screen w-full overflow-hidden bg-slate-950 text-slate-100">
      
      {/* Sidebar */}
      <div 
        className={`${
          isSidebarOpen ? 'w-80' : 'w-0'
        } bg-slate-900 border-r border-slate-800 transition-all duration-300 flex flex-col relative shrink-0`}
      >
        <div className="p-4 border-b border-slate-800 flex justify-between items-center shrink-0">
          <h1 className="font-bold text-xl flex items-center gap-2 text-blue-400">
            <Settings className="w-5 h-5" />
            DXF Vista
          </h1>
          <button onClick={() => setSidebarOpen(false)} className="md:hidden text-slate-400">
            <X size={20} />
          </button>
        </div>

        {/* TAB SWITCHER */}
        <div className="flex border-b border-slate-800 shrink-0">
             <button 
                onClick={() => setSidebarTab('LAYERS')}
                className={`flex-1 py-3 text-xs font-medium uppercase tracking-wider transition-colors ${
                    sidebarTab === 'LAYERS' 
                    ? 'text-blue-400 border-b-2 border-blue-400 bg-slate-800/50' 
                    : 'text-slate-500 hover:text-slate-300 hover:bg-slate-800'
                }`}
             >
                 <div className="flex items-center justify-center gap-2">
                     <Layers size={14} /> Layers
                 </div>
             </button>
             <button 
                onClick={() => setSidebarTab('ANALYSIS')}
                className={`flex-1 py-3 text-xs font-medium uppercase tracking-wider transition-colors ${
                    sidebarTab === 'ANALYSIS' 
                    ? 'text-blue-400 border-b-2 border-blue-400 bg-slate-800/50' 
                    : 'text-slate-500 hover:text-slate-300 hover:bg-slate-800'
                }`}
             >
                 <div className="flex items-center justify-center gap-2">
                     <Hammer size={14} /> Analysis
                 </div>
             </button>
        </div>

        {/* SIDEBAR CONTENT AREA */}
        <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
        
        {/* === TAB 1: LAYERS === */}
        {sidebarTab === 'LAYERS' && (
          <>
            <div className="p-4 border-b border-slate-800 space-y-4 shrink-0">
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

                {/* Layer Tools */}
                <div className="flex items-center justify-between">
                    <h2 className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Layer List</h2>
                    {activeProject && (
                    <button onClick={toggleAllLayers} className="text-xs text-blue-400 hover:text-blue-300 flex items-center gap-1">
                        <RefreshCw size={10} />
                        {activeProject.activeLayers.size === activeProject.data.layers.length ? 'Hide All' : 'Show All'}
                    </button>
                    )}
                </div>

                {/* Layer Search */}
                {activeProject && (
                    <div className="relative">
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
            </div>

            {/* Scrollable Layer List */}
            {isLoading ? (
                <div className="flex items-center justify-center py-8">
                   <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-blue-500"></div>
                </div>
            ) : !activeProject ? (
                <div className="text-center text-slate-600 text-sm py-8 flex-1 flex flex-col items-center justify-center">
                    <FileIcon className="w-8 h-8 mb-2 opacity-50"/>
                    No file selected
                </div>
            ) : (
                <div className="flex-1 overflow-y-auto p-2 custom-scrollbar">
                    {filteredLayers.length === 0 && (
                        <div className="text-xs text-slate-500 text-center py-4">No matching layers</div>
                    )}
                    {filteredLayers.map((layer) => (
                        <div key={layer} className="flex flex-col mb-0.5">
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
                               <div className="pl-9 pr-2 pb-3 pt-1 grid grid-cols-6 gap-2 bg-slate-900/50 rounded-b mb-1 animate-in fade-in slide-in-from-top-1 duration-200">
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
          </>
        )}

        {/* === TAB 2: ANALYSIS === */}
        {sidebarTab === 'ANALYSIS' && (
             <div className="flex-1 overflow-y-auto">
                <AnalysisSidebar 
                    activeProject={activeProject}
                    projects={projects}
                    isLoading={isLoading}
                    analysisDomain={analysisDomain}
                    setAnalysisDomain={setAnalysisDomain}
                    setProjects={setProjects}
                    setLayerColors={setLayerColors}
                    pickingTarget={pickingTarget}
                    setPickingTarget={setPickingTarget}
                />
             </div>
        )}

        </div>

        {/* Global Tools Footer */}
        <div className="p-4 border-t border-slate-800 space-y-3 shrink-0 bg-slate-900 z-10">
            <div className="col-span-2">
                   <p className="text-[10px] text-slate-500 mb-1 font-medium">GLOBAL TEXT SEARCH</p>
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
               projectName={activeProject?.name}
               pickingTarget={pickingTarget}
               onLayerPicked={handleLayerPick}
             />
        </div>
      </div>
    </div>
  );
};

export default App;
