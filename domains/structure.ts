import React from 'react';
import { DxfEntity, EntityType, Point, Bounds, ProjectFile, ViewportRegion } from '../types';
import { extractEntities } from '../utils/dxfHelpers';
import { getBeamProperties, getCenter, calculateLength, findParallelPolygons, groupEntitiesByProximity, findTitleForBounds, parseViewportTitle, getGridIntersections, calculateMergeVector, getEntityBounds, distancePointToLine } from '../utils/geometryUtils';

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

const expandBounds = (b: Bounds, margin: number): Bounds => ({
    minX: b.minX - margin,
    minY: b.minY - margin,
    maxX: b.maxX + margin,
    maxY: b.maxY + margin
});

const getMergeBaseBounds = (project: ProjectFile, margin: number = 0): Bounds[] | null => {
    if (!project.splitRegions || project.splitRegions.length === 0) return null;

    return project.splitRegions
        .filter(r => !r.info || r.info.index === 1)
        .map(r => margin > 0 ? expandBounds(r.bounds, margin) : r.bounds);
};

const isPointInBounds = (p: Point, b: Bounds) => {
    return p.x >= b.minX && p.x <= b.maxX && p.y >= b.minY && p.y <= b.maxY;
};

const boundsOverlap = (a: Bounds, b: Bounds): boolean => {
    return !(a.maxX < b.minX || a.minX > b.maxX || a.maxY < b.minY || a.minY > b.maxY);
};

const isEntityInBounds = (ent: DxfEntity, boundsList: Bounds[]): boolean => {
    return boundsList.some(b => {
         if (ent.start && isPointInBounds(ent.start, b)) return true;
         if (ent.end && isPointInBounds(ent.end, b)) return true;
         if (ent.type === EntityType.DIMENSION) {
             if (ent.measureStart && isPointInBounds(ent.measureStart, b)) return true;
             if (ent.measureEnd && isPointInBounds(ent.measureEnd, b)) return true;
         }
         const entB = getEntityBounds(ent);
         if (entB) {
             const cx = (entB.minX + entB.maxX)/2;
             const cy = (entB.minY + entB.maxY)/2;
             if (isPointInBounds({x: cx, y: cy}, b)) return true;
             if (boundsOverlap(entB, b)) return true;
         }
         return false;
    });
};

const filterEntitiesInBounds = (entities: DxfEntity[], boundsList: Bounds[] | null): DxfEntity[] => {
    if (!boundsList || boundsList.length === 0) return entities;
    return entities.filter(e => isEntityInBounds(e, boundsList));
};

// --- WALL THICKNESS ESTIMATION ---
const estimateWallThicknesses = (lines: DxfEntity[]): Set<number> => {
    const thicknessCounts = new Map<number, number>();
    const VALID_THICKNESSES = [100, 120, 150, 180, 200, 240, 250, 300, 350, 370, 400, 500, 600];
    
    // Sample a subset if too many lines to avoid O(N^2) lag
    const sample = lines.length > 2000 ? lines.filter((_, i) => i % 2 === 0) : lines;

    for (let i = 0; i < sample.length; i++) {
        const l1 = sample[i];
        if (!l1.start || !l1.end) continue;
        const v1 = { x: l1.end.x - l1.start.x, y: l1.end.y - l1.start.y };
        const len1 = Math.sqrt(v1.x*v1.x + v1.y*v1.y);
        if (len1 < 100) continue;

        for (let j = i + 1; j < sample.length; j++) {
            const l2 = sample[j];
            if (!l2.start || !l2.end) continue;
            
            // Fast check: length similarity not required for walls (one can be long, one short)
            
            // Check parallelism
            const v2 = { x: l2.end.x - l2.start.x, y: l2.end.y - l2.start.y };
            const len2 = Math.sqrt(v2.x*v2.x + v2.y*v2.y);
            const dot = (v1.x * v2.x + v1.y * v2.y) / (len1 * len2);
            if (Math.abs(dot) < 0.98) continue;

            // Check distance
            const center = { x: (l2.start.x + l2.end.x)/2, y: (l2.start.y + l2.end.y)/2 };
            const dist = distancePointToLine(center, l1.start, l1.end);
            
            if (dist > 50 && dist < 800) {
                // Round to nearest 10
                const rounded = Math.round(dist / 10) * 10;
                thicknessCounts.set(rounded, (thicknessCounts.get(rounded) || 0) + 1);
            }
        }
    }

    const result = new Set<number>();
    // Filter for frequent thicknesses that match standard construction sizes
    thicknessCounts.forEach((count, thick) => {
        if (count > 2) { // Threshold
             // Check if it's close to a standard size or just a very frequent measurement
             const isStandard = VALID_THICKNESSES.some(std => Math.abs(std - thick) <= 5);
             if (isStandard || count > 10) {
                 result.add(thick);
             }
        }
    });
    
    return result;
};


// --- LOGIC FUNCTIONS ---

export const runCalculateBeams = (
    activeProject: ProjectFile, 
    projects: ProjectFile[], 
    setProjects: React.Dispatch<React.SetStateAction<ProjectFile[]>>,
    setLayerColors: React.Dispatch<React.SetStateAction<Record<string, string>>>
) => {
    const baseBounds = getMergeBaseBounds(activeProject, 2500);
    const currentData = activeProject.data;
    
    const beamTextLayers = currentData.layers.filter(l => l.includes('梁筋'));
    const beamLayers = ['BEAM', 'BEAM_CON'];
    
    let rawEntities = extractEntities(beamLayers, currentData.entities, currentData.blocks, currentData.blockBasePoints);
    let rawAxisEntities = extractEntities(['AXIS'], currentData.entities, currentData.blocks, currentData.blockBasePoints).filter(e => e.type === EntityType.LINE);
    let rawTextEntities = extractEntities(beamTextLayers, currentData.entities, currentData.blocks, currentData.blockBasePoints).filter(e => e.type === EntityType.TEXT);

    const entities = filterEntitiesInBounds(rawEntities, baseBounds);
    const axisEntities = filterEntitiesInBounds(rawAxisEntities, baseBounds);
    const textEntities = filterEntitiesInBounds(rawTextEntities, baseBounds);

    let obstacles = extractEntities(['WALL', 'COLU', 'COLUMN', 'WALL_CALC', 'COLU_CALC'], currentData.entities, currentData.blocks, currentData.blockBasePoints);
    obstacles = filterEntitiesInBounds(obstacles, baseBounds);
    
    if (obstacles.length < 10) {
         const globalObstacles = findEntitiesInAllProjects(projects, /wall|colu|column|柱|墙/i);
         obstacles = globalObstacles;
    }

    if (axisEntities.length === 0) {
        const globalAxis = findEntitiesInAllProjects(projects, /^AXIS$/i).filter(e => e.type === EntityType.LINE);
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
    
    const resultLayer = 'BEAM_CALC';
    const contextLayers = ['WALL', 'COLU', 'AXIS', ...beamTextLayers];

    const newEntities: DxfEntity[] = [];
    const lines = entities.filter(e => e.type === EntityType.LINE);
    const polylines = entities.filter(e => e.type === EntityType.LWPOLYLINE && e.closed);

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
        console.log("No calculable beams found.");
        return;
    }

    updateProject(activeProject, setProjects, setLayerColors, resultLayer, newEntities, '#00FF00', contextLayers, true);
    console.log(`Calculated ${allBeams.length} beam segments.`);
};

export const runCalculateWalls = (
    activeProject: ProjectFile, 
    projects: ProjectFile[], 
    setProjects: React.Dispatch<React.SetStateAction<ProjectFile[]>>,
    setLayerColors: React.Dispatch<React.SetStateAction<Record<string, string>>>
) => {
    const baseBounds = getMergeBaseBounds(activeProject, 2500);

    // 1. Prepare Layers
    const targetLayers = activeProject.data.layers.filter(l => /wall|墙/i.test(l));
    
    // 2. Prepare Obstacles (COLUMNS ONLY - Walls stop at columns, but continue through Beams)
    let columnObstacles = findEntitiesInAllProjects(projects, /colu|column|柱/i);
    // Include calculated columns if they exist
    const calcColumns = extractEntities(['COLU_CALC'], activeProject.data.entities, activeProject.data.blocks, activeProject.data.blockBasePoints);
    columnObstacles = [...columnObstacles, ...calcColumns];
    columnObstacles = filterEntitiesInBounds(columnObstacles, baseBounds);

    // 3. Prepare Axis
    const rawAxisEntities = extractEntities(['AXIS'], activeProject.data.entities, activeProject.data.blocks, activeProject.data.blockBasePoints);
    let axisLines: DxfEntity[] = [];
    
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

    axisLines = filterEntitiesInBounds(axisLines, baseBounds);
    
    if (axisLines.length === 0) {
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

    // 5. Auto-Detect Thickness
    const estimatedWidths = estimateWallThicknesses(candidateLines);
    if (estimatedWidths.size === 0) {
        // Fallback defaults if detection fails
        estimatedWidths.add(200);
        estimatedWidths.add(240);
        estimatedWidths.add(100);
    }
    const widthStr = Array.from(estimatedWidths).join(', ');

    // Run Algorithm
    const generatedWalls = findParallelPolygons(candidateLines, 600, resultLayer, columnObstacles, axisLines, [], 'WALL', estimatedWidths);
    
    const newEntities: DxfEntity[] = [...generatedWalls, ...existingClosedPolygons];

    if (newEntities.length === 0) {
        console.log("No valid wall segments found.");
        return;
    }

    updateProject(activeProject, setProjects, setLayerColors, resultLayer, newEntities, '#94a3b8', contextLayers, true);
    
    let msg = `Marked ${newEntities.length} wall segments. (Thicknesses: ${widthStr})`;
    if (baseBounds) msg += ` (Restricted to ${baseBounds.length} merged regions)`;
    console.log(msg);
};

export const runCalculateColumns = (
    activeProject: ProjectFile, 
    projects: ProjectFile[], 
    setProjects: React.Dispatch<React.SetStateAction<ProjectFile[]>>,
    setLayerColors: React.Dispatch<React.SetStateAction<Record<string, string>>>
) => {
    const baseBounds = getMergeBaseBounds(activeProject, 2500);
    const targetLayers = activeProject.data.layers.filter(l => /colu|column|柱/i.test(l));
    const resultLayer = 'COLU_CALC';
    const contextLayers = ['AXIS', 'WALL_CALC', 'BEAM_CALC'];

    let rawEntities = extractEntities(targetLayers, activeProject.data.entities, activeProject.data.blocks, activeProject.data.blockBasePoints);

    rawEntities = filterEntitiesInBounds(rawEntities, baseBounds);

    const columnEntities = rawEntities.filter(e => 
        (e.type === EntityType.LWPOLYLINE && e.closed) ||
        e.type === EntityType.CIRCLE ||
        e.type === EntityType.INSERT
    ).map(e => ({...e, layer: resultLayer}));

    if (columnEntities.length === 0) {
        console.log("No valid column objects found on column layers.");
        return;
    }

    updateProject(activeProject, setProjects, setLayerColors, resultLayer, columnEntities, '#f59e0b', contextLayers, true);
    
    let msg = `Marked ${columnEntities.length} columns.`;
    if (baseBounds) msg += ` (Restricted to ${baseBounds.length} merged regions)`;
    console.log(msg);
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
         if (!suppressAlert) console.log("No AXIS lines found to determine regions.");
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
        if (!suppressAlert) console.log("Could not determine split regions.");
        return null;
    }

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

    if (!suppressAlert) console.log(`Found ${clusters.length} regions.`);
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
        console.log("Could not identify regions to merge.");
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
    const LABEL_MARGIN = 2000; 

    const isLabelEntity = (ent: DxfEntity): boolean => {
        const u = ent.layer.toUpperCase();
        if (u.includes('AXIS') || u.includes('轴')) return false;
        const layerLooksLabel = u.includes('标注') || u.includes('DIM') || u.includes('LABEL') || /^Z[\u4e00-\u9fa5]/.test(ent.layer);

        if (ent.type === EntityType.DIMENSION) return true;
        if (ent.type === EntityType.TEXT || ent.type === EntityType.ATTRIB) return layerLooksLabel;
        return layerLooksLabel;
    };

    const shouldIncludeEntity = (ent: DxfEntity, bounds: Bounds): boolean => {
         const expanded = expandBounds(bounds, LABEL_MARGIN);
         if (ent.start && isPointInBounds(ent.start, expanded)) return true;
         if (ent.type === EntityType.DIMENSION) {
             if (ent.measureStart && isPointInBounds(ent.measureStart, expanded)) return true;
             if (ent.measureEnd && isPointInBounds(ent.measureEnd, expanded)) return true;
             if (ent.end && isPointInBounds(ent.end, expanded)) return true;
         }
         const b = getEntityBounds(ent);
         if (b) {
             const cx = (b.minX + b.maxX)/2;
             const cy = (b.minY + b.maxY)/2;
             if (isPointInBounds({x: cx, y: cy}, expanded)) return true;
             if (boundsOverlap(b, expanded)) return true;
         }
         return false;
    };

    Object.entries(groups).forEach(([prefix, views]) => {
        views.sort((a, b) => (a.info?.index ?? 1) - (b.info?.index ?? 1));
        const baseView = views[0]; 
        
        allEntities.forEach(ent => {
           if (shouldIncludeEntity(ent, baseView.bounds) && isLabelEntity(ent)) {
               const clone = { ...ent, layer: resultLayer };
               mergedEntities.push(clone);
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
                        if (shouldIncludeEntity(ent, targetView.bounds) && isLabelEntity(ent)) {
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
        }
        mergedCount++;
    });

    if (mergedEntities.length === 0) {
        console.log("No label entities found to merge.");
        return;
    }
    
    updateProject(activeProject, setProjects, setLayerColors, resultLayer, mergedEntities, '#00FFFF', [], false); 
    console.log(`Consolidated labels from ${mergedCount} view groups into '${resultLayer}'.`);
};