import { DxfEntity, EntityType, Point, Bounds, ProjectFile, ViewportRegion } from '../types';
import { extractEntities } from '../utils/dxfHelpers';
import { getBeamProperties, getCenter, calculateLength, findParallelPolygons, groupEntitiesByProximity, findTitleForBounds, parseViewportTitle, getGridIntersections, calculateMergeVector, getEntityBounds } from '../utils/geometryUtils';

// --- HELPERS ---

// Helper to find entities across all loaded projects
const findEntitiesInAllProjects = (
    projects: ProjectFile[], 
    layerNamePattern: RegExp
): DxfEntity[] => {
    let results: DxfEntity[] = [];
    projects.forEach(p => {
        const matchingLayers = p.data.layers.filter(l => layerNamePattern.test(l));
        if (matchingLayers.length > 0) {
            results = results.concat(extractEntities(matchingLayers, p.data.entities, p.data.blocks, p.data.blockBasePoints));
        }
    });
    return results;
};

const updateProject = (
    activeProject: ProjectFile,
    setProjects: React.Dispatch<React.SetStateAction<ProjectFile[]>>,
    setLayerColors: React.Dispatch<React.SetStateAction<Record<string, string>>>,
    resultLayer: string, 
    newEntities: DxfEntity[], 
    color: string, 
    contextLayers: string[], 
    fillLayer: boolean,
    splitRegionsUpdate?: ViewportRegion[]
) => {
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

            return { 
                ...p, 
                data: updatedData, 
                activeLayers: newActive, 
                filledLayers: newFilled,
                splitRegions: splitRegionsUpdate || p.splitRegions
            };
        }
        return p;
    }));
};

// --- SPATIAL FILTERING HELPERS ---

const getMergeBaseBounds = (project: ProjectFile): Bounds[] | null => {
    // If no regions defined, we can't filter, so return null (implies "use everything")
    if (!project.splitRegions || project.splitRegions.length === 0) return null;

    // Filter for "Base Views":
    // 1. Regions with index 1 (e.g. "Plan (1)")
    // 2. Regions with no index info (Single view drawings)
    return project.splitRegions
        .filter(r => !r.info || r.info.index === 1)
        .map(r => r.bounds);
};

const isPointInBounds = (p: Point, b: Bounds) => {
    return p.x >= b.minX && p.x <= b.maxX && p.y >= b.minY && p.y <= b.maxY;
};

const isEntityInBounds = (ent: DxfEntity, boundsList: Bounds[]): boolean => {
    // Check if entity is inside ANY of the base view bounds
    return boundsList.some(b => {
         // Check Start Point
         if (ent.start && isPointInBounds(ent.start, b)) return true;
         
         // Check End Point (Line/Polyline)
         if (ent.end && isPointInBounds(ent.end, b)) return true;

         // Check Dimension points
         if (ent.type === EntityType.DIMENSION) {
             if (ent.measureStart && isPointInBounds(ent.measureStart, b)) return true;
             if (ent.measureEnd && isPointInBounds(ent.measureEnd, b)) return true;
         }

         // Check Bounding Box Center (Fallback)
         const entB = getEntityBounds(ent);
         if (entB) {
             const cx = (entB.minX + entB.maxX)/2;
             const cy = (entB.minY + entB.maxY)/2;
             if (isPointInBounds({x: cx, y: cy}, b)) return true;
         }

         return false;
    });
};

const filterEntitiesInBounds = (entities: DxfEntity[], boundsList: Bounds[] | null): DxfEntity[] => {
    if (!boundsList || boundsList.length === 0) return entities; // No filter applied
    return entities.filter(e => isEntityInBounds(e, boundsList));
};


// --- LOGIC FUNCTIONS ---

export const runCalculateBeams = (
    activeProject: ProjectFile, 
    projects: ProjectFile[], 
    setProjects: React.Dispatch<React.SetStateAction<ProjectFile[]>>,
    setLayerColors: React.Dispatch<React.SetStateAction<Record<string, string>>>
) => {
    const baseBounds = getMergeBaseBounds(activeProject);
    const currentData = activeProject.data;
    
    // 1. Extract raw candidates
    const beamTextLayers = currentData.layers.filter(l => l.includes('梁筋'));
    const beamLayers = ['BEAM', 'BEAM_CON'];
    
    let rawEntities = extractEntities(beamLayers, currentData.entities, currentData.blocks, currentData.blockBasePoints);
    let rawAxisEntities = extractEntities(['AXIS'], currentData.entities, currentData.blocks, currentData.blockBasePoints).filter(e => e.type === EntityType.LINE);
    let rawTextEntities = extractEntities(beamTextLayers, currentData.entities, currentData.blocks, currentData.blockBasePoints).filter(e => e.type === EntityType.TEXT);

    // 2. Filter Candidates to Base View (Avoid calculating View 2, 3...)
    const entities = filterEntitiesInBounds(rawEntities, baseBounds);
    const axisEntities = filterEntitiesInBounds(rawAxisEntities, baseBounds);
    const textEntities = filterEntitiesInBounds(rawTextEntities, baseBounds);

    // 3. Prepare Obstacles (Walls/Columns)
    // We should also filter obstacles to the same bounds to optimize
    let obstacles = extractEntities(['WALL', 'COLU', 'COLUMN', 'WALL_CALC', 'COLU_CALC'], currentData.entities, currentData.blocks, currentData.blockBasePoints);
    obstacles = filterEntitiesInBounds(obstacles, baseBounds);
    
    // Fallback to global project search if local obstacles are sparse (e.g. XRef)
    if (obstacles.length < 10) {
         const globalObstacles = findEntitiesInAllProjects(projects, /wall|colu|column|柱|墙/i);
         // Even global obstacles should ideally be filtered if they are in the same coordinate space, 
         // but usually XRefs match the coordinate space. For safety, we keep them all or filter if possible.
         obstacles = globalObstacles;
    }

    if (axisEntities.length === 0) {
        // Fallback axis
        const globalAxis = findEntitiesInAllProjects(projects, /^AXIS$/i).filter(e => e.type === EntityType.LINE);
        // Only take those in bounds
        globalAxis.forEach(ax => {
            if (!baseBounds || isEntityInBounds(ax, baseBounds)) axisEntities.push(ax);
        });
    }
    
    if (textEntities.length === 0) {
        const globalText = findEntitiesInAllProjects(projects, /梁筋/).filter(e => e.type === EntityType.TEXT);
        globalText.forEach(txt => {
            if (!baseBounds || isEntityInBounds(txt, baseBounds)) textEntities.push(txt);
        });
    }

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

    // Run Algorithm
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

    updateProject(activeProject, setProjects, setLayerColors, resultLayer, newEntities, '#00FF00', contextLayers, true);
    
    let msg = `Calculated ${allBeams.length} beam segments.`;
    if (baseBounds) msg += ` (Restricted to ${baseBounds.length} merged regions)`;
    if (validWidths.size > 0) msg += `\nUsed widths: ${foundWidthsArray.join(', ')}`;
    
    alert(msg);
};

export const runCalculateWalls = (
    activeProject: ProjectFile, 
    projects: ProjectFile[], 
    setProjects: React.Dispatch<React.SetStateAction<ProjectFile[]>>,
    setLayerColors: React.Dispatch<React.SetStateAction<Record<string, string>>>
) => {
    const baseBounds = getMergeBaseBounds(activeProject);

    // 1. Prepare Layers
    const targetLayers = activeProject.data.layers.filter(l => /wall|墙/i.test(l));
    
    // 2. Prepare Obstacles (Columns)
    let columnObstacles = findEntitiesInAllProjects(projects, /colu|column|柱/i);
    // Filter obstacles to relevant area
    columnObstacles = filterEntitiesInBounds(columnObstacles, baseBounds);

    // 3. Prepare Axis
    const rawAxisEntities = extractEntities(['AXIS'], activeProject.data.entities, activeProject.data.blocks, activeProject.data.blockBasePoints);
    let axisLines: DxfEntity[] = [];
    
    // Convert Polyline axis to Lines
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

    // Filter Axis
    axisLines = filterEntitiesInBounds(axisLines, baseBounds);
    
    if (axisLines.length === 0) {
        // Fallback global axis
        const otherAxis = findEntitiesInAllProjects(projects, /^AXIS$/i);
        otherAxis.forEach(ent => {
             if (ent.type === EntityType.LINE) {
                 if (!baseBounds || isEntityInBounds(ent, baseBounds)) axisLines.push(ent);
             }
        });
    }

    const resultLayer = 'WALL_CALC';
    const contextLayers = ['AXIS', 'COLU', 'BEAM_CALC'];

    // 4. Extract Wall Candidates
    let rawWallEntities = extractEntities(targetLayers, activeProject.data.entities, activeProject.data.blocks, activeProject.data.blockBasePoints);
    
    // Filter Candidates
    rawWallEntities = filterEntitiesInBounds(rawWallEntities, baseBounds);
    
    const candidateLines: DxfEntity[] = [];
    const existingClosedPolygons: DxfEntity[] = [];

    rawWallEntities.forEach(ent => {
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

    // Run Algorithm
    const allObstacles = [...columnObstacles, ...rawWallEntities]; // Self-obstruction for trimming
    const generatedWalls = findParallelPolygons(candidateLines, 600, resultLayer, allObstacles, axisLines, [], 'WALL');
    
    const newEntities: DxfEntity[] = [...generatedWalls, ...existingClosedPolygons];

    if (newEntities.length === 0) {
        alert("No valid wall segments found (Must have corresponding Axis line).");
        return;
    }

    updateProject(activeProject, setProjects, setLayerColors, resultLayer, newEntities, '#94a3b8', contextLayers, true);
    
    let msg = `Marked ${newEntities.length} wall segments.`;
    if (baseBounds) msg += ` (Restricted to ${baseBounds.length} merged regions)`;
    alert(msg);
};

export const runCalculateColumns = (
    activeProject: ProjectFile, 
    projects: ProjectFile[], 
    setProjects: React.Dispatch<React.SetStateAction<ProjectFile[]>>,
    setLayerColors: React.Dispatch<React.SetStateAction<Record<string, string>>>
) => {
    const baseBounds = getMergeBaseBounds(activeProject);
    const targetLayers = activeProject.data.layers.filter(l => /colu|column|柱/i.test(l));
    const resultLayer = 'COLU_CALC';
    const contextLayers = ['AXIS', 'WALL_CALC', 'BEAM_CALC'];

    let rawEntities = extractEntities(targetLayers, activeProject.data.entities, activeProject.data.blocks, activeProject.data.blockBasePoints);

    // Filter Columns to Base View
    rawEntities = filterEntitiesInBounds(rawEntities, baseBounds);

    const columnEntities = rawEntities.filter(e => 
        (e.type === EntityType.LWPOLYLINE && e.closed) ||
        e.type === EntityType.CIRCLE ||
        e.type === EntityType.INSERT
    ).map(e => ({...e, layer: resultLayer}));

    if (columnEntities.length === 0) {
        alert("No valid column objects found on column layers.");
        return;
    }

    updateProject(activeProject, setProjects, setLayerColors, resultLayer, columnEntities, '#f59e0b', contextLayers, true);
    
    let msg = `Marked ${columnEntities.length} columns.`;
    if (baseBounds) msg += ` (Restricted to ${baseBounds.length} merged regions)`;
    alert(msg);
};

export const runCalculateSplitRegions = (
    activeProject: ProjectFile,
    setProjects: React.Dispatch<React.SetStateAction<ProjectFile[]>>,
    setLayerColors: React.Dispatch<React.SetStateAction<Record<string, string>>>,
    suppressAlert = false
): ViewportRegion[] | null => {
    const resultLayer = 'VIEWPORT_CALC';
    const debugLayer = 'VIEWPORT_DEBUG';

    const axisLayers = activeProject.data.layers.filter(l => l.toUpperCase().includes('AXIS'));
    const axisLines = extractEntities(axisLayers, activeProject.data.entities, activeProject.data.blocks, activeProject.data.blockBasePoints)
        .filter(e => e.type === EntityType.LINE || e.type === EntityType.LWPOLYLINE);

    if (axisLines.length === 0) {
        if (!suppressAlert) alert("No AXIS lines found to determine regions.");
        return null;
    }

    const allText = extractEntities(activeProject.data.layers, activeProject.data.entities, activeProject.data.blocks, activeProject.data.blockBasePoints)
        .filter(e => e.type === EntityType.TEXT);
    
    const allLines = extractEntities(activeProject.data.layers, activeProject.data.entities, activeProject.data.blocks, activeProject.data.blockBasePoints)
        .filter(e => e.type === EntityType.LINE || e.type === EntityType.LWPOLYLINE);

    const clusters = groupEntitiesByProximity(axisLines, 5000); 
    
    const newEntities: DxfEntity[] = [];
    const debugEntities: DxfEntity[] = [];
    const regions: ViewportRegion[] = [];

    clusters.forEach((box, i) => {
        const { title, scannedBounds } = findTitleForBounds(box, allText, allLines);
        const label = title || `BLOCK ${i + 1}`;

        regions.push({
            bounds: box,
            title: label,
            info: parseViewportTitle(label)
        });

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

        newEntities.push({
            type: EntityType.TEXT,
            layer: resultLayer,
            text: label,
            start: { x: box.minX, y: box.maxY + 500 },
            radius: 1000 
        });

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

    // Special handling for updateProject because this one modifies 'splitRegions' too
    const updatedData = {
        ...activeProject.data,
        entities: [...activeProject.data.entities, ...newEntities, ...debugEntities],
        layers: [...new Set([...activeProject.data.layers, resultLayer, debugLayer])]
    };

    setLayerColors(prev => ({ ...prev, [resultLayer]: '#FF00FF', [debugLayer]: '#444444' }));

    setProjects(prev => prev.map(p => {
        if (p.id === activeProject.id) {
             const newActive = new Set(p.activeLayers);
             newActive.add(resultLayer);
             return { ...p, data: updatedData, splitRegions: regions, activeLayers: newActive };
        }
        return p;
    }));

    if (!suppressAlert) alert(`Found ${clusters.length} regions.`);
    return regions;
};

export const runMergeViews = (
    activeProject: ProjectFile,
    setProjects: React.Dispatch<React.SetStateAction<ProjectFile[]>>,
    setLayerColors: React.Dispatch<React.SetStateAction<Record<string, string>>>
) => {
    let regions = activeProject.splitRegions;
    
    if (!regions || regions.length === 0) {
        regions = runCalculateSplitRegions(activeProject, setProjects, setLayerColors, true); 
    }

    if (!regions || regions.length === 0) {
        alert("Could not identify regions to merge.");
        return;
    }
    
    const resultLayer = 'MERGE_LABEL';
    const axisLayers = activeProject.data.layers.filter(l => l.toUpperCase().includes('AXIS'));
    const axisLines = extractEntities(axisLayers, activeProject.data.entities, activeProject.data.blocks, activeProject.data.blockBasePoints)
        .filter(e => e.type === EntityType.LINE || e.type === EntityType.LWPOLYLINE);

    const groups: Record<string, ViewportRegion[]> = {};
    regions.forEach(r => {
        const key = r.info ? r.info.prefix : r.title;
        if (!groups[key]) groups[key] = [];
        groups[key].push(r);
    });

    const mergedEntities: DxfEntity[] = [];
    const allEntities = extractEntities(activeProject.data.layers, activeProject.data.entities, activeProject.data.blocks, activeProject.data.blockBasePoints);

    let mergedCount = 0;

    const isLabelLayer = (name: string): boolean => {
        const u = name.toUpperCase();
        return u.includes('标注') || u.includes('DIM') || u.includes('LABEL') || /^Z[\u4e00-\u9fa5]/.test(name);
    };

    const shouldIncludeEntity = (ent: DxfEntity, bounds: Bounds): boolean => {
         // Check Start Point
         if (ent.start && isPointInBounds(ent.start, bounds)) return true;
         
         // Check Dimension points
         if (ent.type === EntityType.DIMENSION) {
             if (ent.measureStart && isPointInBounds(ent.measureStart, bounds)) return true;
             if (ent.measureEnd && isPointInBounds(ent.measureEnd, bounds)) return true;
             if (ent.end && isPointInBounds(ent.end, bounds)) return true;
         }

         // Check Bounding Box Center (Fallback)
         const b = getEntityBounds(ent);
         if (b) {
             const cx = (b.minX + b.maxX)/2;
             const cy = (b.minY + b.maxY)/2;
             if (isPointInBounds({x: cx, y: cy}, bounds)) return true;
         }
         return false;
    };

    // Iterate through all groups (including single-view groups which have no index)
    Object.entries(groups).forEach(([prefix, views]) => {
        views.sort((a, b) => (a.info?.index ?? 1) - (b.info?.index ?? 1));
        const baseView = views[0]; 
        
        // Base View: Keep labels in place
        allEntities.forEach(ent => {
           if (shouldIncludeEntity(ent, baseView.bounds)) {
               if (isLabelLayer(ent.layer)) {
                   const clone = { ...ent, layer: resultLayer };
                   mergedEntities.push(clone);
               }
           }
        });
        
        if (views.length > 1) {
            const baseIntersections = getGridIntersections(baseView.bounds, axisLines);

            for (let i = 1; i < views.length; i++) {
                const targetView = views[i];
                const targetIntersections = getGridIntersections(targetView.bounds, axisLines);
                
                const vec = calculateMergeVector(baseIntersections, targetIntersections);
                
                if (vec) {
                    allEntities.forEach(ent => {
                        if (shouldIncludeEntity(ent, targetView.bounds)) {
                            if (isLabelLayer(ent.layer)) {
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
                        }
                    });
                    mergedCount++;
                }
            }
        }
        mergedCount++;
    });

    if (mergedEntities.length === 0) {
        alert("No label entities found to merge.");
        return;
    }
    
    updateProject(activeProject, setProjects, setLayerColors, resultLayer, mergedEntities, '#00FFFF', [], false); 
    alert(`Consolidated labels from ${mergedCount} view groups into '${resultLayer}'.`);
};