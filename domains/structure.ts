import React from 'react';
import { DxfEntity, EntityType, Point, Bounds, ProjectFile, ViewportRegion } from '../types';
import { extractEntities } from '../utils/dxfHelpers';
import { getBeamProperties, getCenter, calculateLength, findParallelPolygons, findParallelPolygonsBeam, findParallelPolygonsWall, groupEntitiesByProximity, findTitleForBounds, parseViewportTitle, getGridIntersections, calculateMergeVector, getEntityBounds, distancePointToLine, distance, boundsOverlap, rayIntersectsBox, getRayIntersection } from '../utils/geometryUtils';

// --- TYPES & CONSTANTS ---

type BeamTypeTag = 'MAIN' | 'SECONDARY' | 'UNKNOWN';

interface BeamSegment extends DxfEntity {
    __beamId: string;
    beamType?: BeamTypeTag;
    beamLabel?: string | null;
    beamAngle?: number;
}

type BeamOrientation = 'H' | 'V';

const BEAM_LAYER_CANDIDATES = ['BEAM', 'BEAM_CON'];
const DEFAULT_BEAM_STAGE_COLORS: Record<string, string> = {
    BEAM_STEP1_SEGMENTS: '#10b981',
    BEAM_STEP2_ATTR: '#22c55e',
    BEAM_STEP3_LOGIC: '#f59e0b',
    BEAM_STEP4_PROP: '#6366f1',
    BEAM_CALC: '#00FF00' // fallback for legacy call
};

const TYPE_PRIORITY: Record<BeamTypeTag, number> = {
    MAIN: 3,
    SECONDARY: 2,
    UNKNOWN: 1
};

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

// Helper to push merged lines back to DxfEntity format
const pushMergedLine = (r: {minX: number, maxX: number, y: number, original: DxfEntity}, baseAngle: number, target: DxfEntity[]) => {
     const rad = baseAngle * Math.PI / 180;
     const cos = Math.cos(rad);
     const sin = Math.sin(rad);
     
     // Rotate back: x' = x cos - y sin, y' = x sin + y cos
     const sX = r.minX; 
     const sY = r.y;
     const eX = r.maxX;
     const eY = r.y;

     const start = { x: sX * cos - sY * sin, y: sX * sin + sY * cos };
     const end = { x: eX * cos - eY * sin, y: eX * sin + eY * cos };

     target.push({
         type: EntityType.LINE,
         layer: r.original.layer,
         start,
         end
     });
};

// Merges lines that are collinear and overlapping or very close.
const mergeCollinearLines = (lines: DxfEntity[]): DxfEntity[] => {
    // 1. Filter valid lines
    const validLines = lines.filter(l => l.start && l.end && calculateLength(l) > 1);
    if (validLines.length === 0) return [];

    // 2. Normalize Angle (0-180) and prepare data
    const withAngle = validLines.map(l => {
        const dx = l.end!.x - l.start!.x;
        const dy = l.end!.y - l.start!.y;
        let angle = Math.atan2(dy, dx) * 180 / Math.PI;
        if (angle < 0) angle += 180;
        if (angle >= 180) angle -= 180;
        return { l, angle };
    });
    
    // Sort by angle for clustering
    withAngle.sort((a, b) => a.angle - b.angle);

    // 3. Cluster by Angle (Tolerance 2 degrees)
    const angleClusters: typeof withAngle[] = [];
    if (withAngle.length > 0) {
        let currentGroup = [withAngle[0]];
        for (let i = 1; i < withAngle.length; i++) {
            const prev = currentGroup[0].angle;
            const curr = withAngle[i].angle;
            if (Math.abs(curr - prev) < 2.0) {
                currentGroup.push(withAngle[i]);
            } else {
                angleClusters.push(currentGroup);
                currentGroup = [withAngle[i]];
            }
        }
        angleClusters.push(currentGroup);
    }

    const mergedLines: DxfEntity[] = [];

    angleClusters.forEach(cluster => {
        // Calculate average angle
        const avgAngle = cluster.reduce((sum, item) => sum + item.angle, 0) / cluster.length;
        const rad = -avgAngle * Math.PI / 180; // Rotate to horizontal
        const cos = Math.cos(rad);
        const sin = Math.sin(rad);

        const rotated = cluster.map(item => {
             const l = item.l;
             const s = l.start!;
             const e = l.end!;
             const rs = { x: s.x * cos - s.y * sin, y: s.x * sin + s.y * cos };
             const re = { x: e.x * cos - e.y * sin, y: e.x * sin + e.y * cos };
             return {
                 original: l,
                 minX: Math.min(rs.x, re.x),
                 maxX: Math.max(rs.x, re.x),
                 y: (rs.y + re.y) / 2
             };
        });

        rotated.sort((a, b) => a.y - b.y);

        // Cluster by Lateral Proximity (Tolerance 150mm - catches double lines of a beam)
        let yClusters: typeof rotated[] = [];
        if (rotated.length > 0) {
            let currYGroup = [rotated[0]];
            for (let i = 1; i < rotated.length; i++) {
                if (Math.abs(rotated[i].y - currYGroup[0].y) < 150) { 
                    currYGroup.push(rotated[i]);
                } else {
                    yClusters.push(currYGroup);
                    currYGroup = [rotated[i]];
                }
            }
            yClusters.push(currYGroup);
        }

        yClusters.forEach(yGroup => {
            // Calculate group average Y for the merged axis
            const avgY = yGroup.reduce((s, i) => s + i.y, 0) / yGroup.length;
            
            yGroup.sort((a, b) => a.minX - b.minX);
            
            let curr = { ...yGroup[0], y: avgY }; // Use avgY
            for (let i = 1; i < yGroup.length; i++) {
                const next = yGroup[i];
                // Gap tolerance: 800mm to bridge labels
                if (next.minX <= curr.maxX + 800) {
                    curr.maxX = Math.max(curr.maxX, next.maxX);
                } else {
                    pushMergedLine(curr, avgAngle, mergedLines);
                    curr = { ...next, y: avgY };
                }
            }
            pushMergedLine(curr, avgAngle, mergedLines);
        });
    });

    return mergedLines;
};

// --- BEAM HELPERS ---

const normalizeAngle = (angle: number): number => {
    const norm = angle % 180;
    return norm < 0 ? norm + 180 : norm;
};

const getOrientation = (angle: number): BeamOrientation => {
    const norm = normalizeAngle(angle);
    return norm > 45 && norm < 135 ? 'V' : 'H';
};

const parseBeamTypeFromText = (text: string | undefined): { label: string | null, type: BeamTypeTag } => {
    if (!text) return { label: null, type: 'UNKNOWN' };
    const cleaned = text.replace(/\s+/g, '').toUpperCase();

    if (/KL|WKL|XL|LL/.test(cleaned)) {
        return { label: cleaned, type: 'MAIN' };
    }
    if (/L\d+/.test(cleaned) || /[A-Z]L-?\d+/.test(cleaned)) {
        return { label: cleaned, type: 'SECONDARY' };
    }
    if (/L/.test(cleaned)) {
        return { label: cleaned, type: 'SECONDARY' };
    }
    return { label: null, type: 'UNKNOWN' };
};

const hydrateBeamSegmentsFromLayer = (project: ProjectFile, layer: string): BeamSegment[] => {
    return project.data.entities
        .filter(e => e.layer === layer && e.type === EntityType.LWPOLYLINE && e.closed)
        .map((e, idx) => {
            const props = getBeamProperties(e);
            return {
                ...(e as DxfEntity),
                __beamId: (e as any).__beamId || `beam-${layer}-${idx}`,
                beamType: (e as any).beamType || 'UNKNOWN',
                beamLabel: (e as any).beamLabel || null,
                beamAngle: (e as any).beamAngle ?? normalizeAngle(props.angle)
            } as BeamSegment;
        });
};

const collectBeamSources = (
    activeProject: ProjectFile,
    projects: ProjectFile[]
) => {
    if (!activeProject.splitRegions || activeProject.splitRegions.length === 0) {
        console.log('Beam pipeline requires Split Views first.');
        return null;
    }
    const hasMergeLabel = activeProject.data.layers.includes('MERGE_LABEL');
    const hasWalls = activeProject.data.layers.includes('WALL_CALC');
    const hasCols = activeProject.data.layers.includes('COLU_CALC');
    if (!hasMergeLabel || !hasWalls || !hasCols) {
        console.log('Beam pipeline requires Merge Views plus Columns and Walls.');
        return null;
    }

    const baseBounds = getMergeBaseBounds(activeProject, 2500);
    const beamTextLayers = activeProject.data.layers.filter(l => l === 'MERGE_LABEL');
    const beamLayers = BEAM_LAYER_CANDIDATES;

    let rawEntities = extractEntities(beamLayers, activeProject.data.entities, activeProject.data.blocks, activeProject.data.blockBasePoints);
    let rawAxisEntities = extractEntities(['AXIS'], activeProject.data.entities, activeProject.data.blocks, activeProject.data.blockBasePoints).filter(e => e.type === EntityType.LINE);
    let rawTextEntities = extractEntities(beamTextLayers, activeProject.data.entities, activeProject.data.blocks, activeProject.data.blockBasePoints)
        .filter(e => e.type === EntityType.TEXT && !e.layer.toUpperCase().startsWith('Z'));

    const entities = filterEntitiesInBounds(rawEntities, baseBounds);
    const axisEntities = filterEntitiesInBounds(rawAxisEntities, baseBounds);
    const textEntities = filterEntitiesInBounds(rawTextEntities, baseBounds);

    let obstacles = extractEntities(['WALL_CALC', 'COLU_CALC'], activeProject.data.entities, activeProject.data.blocks, activeProject.data.blockBasePoints);
    if (obstacles.length === 0) {
        obstacles = extractEntities(['WALL', 'COLU', 'COLUMN'], activeProject.data.entities, activeProject.data.blocks, activeProject.data.blockBasePoints);
    }
    obstacles = filterEntitiesInBounds(obstacles, baseBounds);
    
    if (obstacles.length < 10) {
         const globalObstacles = findEntitiesInAllProjects(projects, /wall|colu|column/i);
         obstacles = globalObstacles;
    }

    const axisLines = [...axisEntities];
    if (axisLines.length === 0) {
        const globalAxis = findEntitiesInAllProjects(projects, /^AXIS$/i).filter(e => e.type === EntityType.LINE);
        globalAxis.forEach(ax => {
            if (!baseBounds || isEntityInBounds(ax, baseBounds)) axisLines.push(ax);
        });
    }
    
    const textPool = [...textEntities];
    const validWidths = new Set<number>();
    textPool.forEach(t => {
        if (!t.text) return;
        const matches = t.text.match(/(\d+)[xX×]\d+/);
        if (matches) {
            const w = parseInt(matches[1], 10);
            if (!isNaN(w) && w > 0) validWidths.add(w);
        }
    });

    // Prepare Lines: Include LINE entities AND explode LWPOLYLINE segments
    const lines: DxfEntity[] = [];
    const polylines: DxfEntity[] = [];

    entities.forEach(ent => {
        if (ent.type === EntityType.LINE) {
            lines.push(ent);
        } else if (ent.type === EntityType.LWPOLYLINE && ent.vertices && ent.vertices.length > 1) {
            if (ent.closed) polylines.push(ent);
            
            // Explode polyline into segments for source processing
            const verts = ent.vertices;
            for(let i=0; i<verts.length - 1; i++) {
                 lines.push({ type: EntityType.LINE, layer: ent.layer, start: verts[i], end: verts[i+1] });
            }
            if (ent.closed) {
                 lines.push({ type: EntityType.LINE, layer: ent.layer, start: verts[verts.length-1], end: verts[0] });
            }
        }
    });

    const mergedLines = mergeCollinearLines(lines);

    return {
        baseBounds,
        beamTextLayers,
        axisLines,
        textPool,
        obstacles,
        validWidths,
        lines: mergedLines,
        polylines
    };
};

const extendBeamPolygons = (
    polys: DxfEntity[],
    validWidths: Set<number>,
    beamLines: DxfEntity[],
    obstacles: DxfEntity[]
): DxfEntity[] => {
    // Helper: Project point p onto axis defined by origin+u
    const project = (p: Point, origin: Point, u: Point) => (p.x - origin.x) * u.x + (p.y - origin.y) * u.y;

    return polys.map(poly => {
        // Safe Guard: Only handle rectangular polygons
        if (!poly.vertices || poly.vertices.length !== 4) return poly;

        const center = getCenter(poly);
        if (!center) return poly;

        const p0 = poly.vertices[0];
        const p1 = poly.vertices[1];
        const p3 = poly.vertices[3]; 

        const v01 = { x: p1.x - p0.x, y: p1.y - p0.y };
        const v03 = { x: p3.x - p0.x, y: p3.y - p0.y };
        const len01 = Math.sqrt(v01.x * v01.x + v01.y * v01.y);
        const len03 = Math.sqrt(v03.x * v03.x + v03.y * v03.y);

        let u: Point, n: Point, halfWidth: number;
        
        if (len01 > len03) {
            u = { x: v01.x / len01, y: v01.y / len01 };
            n = { x: v03.x / len03, y: v03.y / len03 };
            halfWidth = len03 / 2;
        } else {
            u = { x: v03.x / len03, y: v03.y / len03 };
            n = { x: v01.x / len01, y: v01.y / len01 };
            halfWidth = len01 / 2;
        }

        let currentMin = Infinity;
        let currentMax = -Infinity;
        poly.vertices.forEach(v => {
            const t = project(v, center, u);
            currentMin = Math.min(currentMin, t);
            currentMax = Math.max(currentMax, t);
        });

        // Connectivity Search
        const activeLines = new Set<DxfEntity>();
        
        for (const line of beamLines) {
             if (!line.start || !line.end) continue;

             const lDir = { x: line.end.x - line.start.x, y: line.end.y - line.start.y };
             const lLen = Math.sqrt(lDir.x*lDir.x + lDir.y*lDir.y);
             if (lLen < 1) continue;
             const dot = (lDir.x * u.x + lDir.y * u.y) / lLen;
             if (Math.abs(dot) < 0.98) continue;

             const mid = { x: (line.start.x+line.end.x)/2, y: (line.start.y+line.end.y)/2 };
             const latDist = Math.abs(project(mid, center, n));
             if (latDist > halfWidth * 1.5) continue; 

             const t1 = project(line.start, center, u);
             const t2 = project(line.end, center, u);
             const lMin = Math.min(t1, t2);
             const lMax = Math.max(t1, t2);
             
             if (Math.max(currentMin, lMin) < Math.min(currentMax, lMax)) {
                 activeLines.add(line);
             }
        }

        // Only bridge if we found seeds
        if (activeLines.size > 0) {
            let changed = true;
            const BRIDGE_GAP = 100;
            const activeArr = Array.from(activeLines);
            
            while(changed) {
                changed = false;
                for (const line of beamLines) {
                    if (activeLines.has(line)) continue;
                    if (!line.start || !line.end) continue;

                    const lDir = { x: line.end.x - line.start.x, y: line.end.y - line.start.y };
                    const lLen = Math.sqrt(lDir.x*lDir.x + lDir.y*lDir.y);
                    if (lLen < 1) continue;
                    const dot = (lDir.x * u.x + lDir.y * u.y) / lLen;
                    if (Math.abs(dot) < 0.98) continue;

                    const mid = { x: (line.start.x+line.end.x)/2, y: (line.start.y+line.end.y)/2 };
                    const latDist = Math.abs(project(mid, center, n));
                    if (latDist > halfWidth * 1.5) continue;

                    const t1 = project(line.start, center, u);
                    const t2 = project(line.end, center, u);
                    const lMin = Math.min(t1, t2);
                    const lMax = Math.max(t1, t2);

                    const connected = activeArr.some(active => {
                        const a1 = project(active.start!, center, u);
                        const a2 = project(active.end!, center, u);
                        const aMin = Math.min(a1, a2);
                        const aMax = Math.max(a1, a2);
                        const dist = Math.max(0, lMin - aMax, aMin - lMax);
                        return dist < BRIDGE_GAP;
                    });

                    if (connected) {
                        activeLines.add(line);
                        activeArr.push(line);
                        changed = true;
                    }
                }
            }
        }

        // If no lines found, fallback: check if we are ALREADY overlapping a wall at ends? 
        // No, if no lines found, we can't extend safely. Return as is.
        if (activeLines.size === 0) return poly;

        // Calculate Drafted Limit
        let draftedMin = currentMin;
        let draftedMax = currentMax;

        activeLines.forEach(l => {
             const t1 = project(l.start!, center, u);
             const t2 = project(l.end!, center, u);
             draftedMin = Math.min(draftedMin, t1, t2);
             draftedMax = Math.max(draftedMax, t1, t2);
        });

        // Perform Constrained Raycast
        const backOrigin = { x: center.x + u.x * currentMin, y: center.y + u.y * currentMin };
        const backDir = { x: -u.x, y: -u.y };
        
        const desiredBack = Math.max(0, currentMin - draftedMin);
        const distBack = getRayIntersection(backOrigin, backDir, obstacles);
        const actualBack = (distBack === Infinity) 
            ? desiredBack 
            : Math.min(desiredBack, Math.max(0, distBack - 5));

        const finalMin = currentMin - actualBack;

        const fwdOrigin = { x: center.x + u.x * currentMax, y: center.y + u.y * currentMax };
        const fwdDir = { x: u.x, y: u.y };
        
        const desiredFwd = Math.max(0, draftedMax - currentMax);
        const distFwd = getRayIntersection(fwdOrigin, fwdDir, obstacles);
        const actualFwd = (distFwd === Infinity) 
            ? desiredFwd 
            : Math.min(desiredFwd, Math.max(0, distFwd - 5));

        const finalMax = currentMax + actualFwd;

        if (Math.abs(finalMin - currentMin) < 1 && Math.abs(finalMax - currentMax) < 1) return poly;

        let nMin = Infinity, nMax = -Infinity;
        poly.vertices.forEach(v => {
            const t = project(v, center, n);
            nMin = Math.min(nMin, t);
            nMax = Math.max(nMax, t);
        });

        const newV0 = { 
            x: center.x + u.x * finalMin + n.x * nMin, 
            y: center.y + u.y * finalMin + n.y * nMin 
        };
        const newV1 = { 
            x: center.x + u.x * finalMax + n.x * nMin, 
            y: center.y + u.y * finalMax + n.y * nMin 
        };
        const newV2 = { 
            x: center.x + u.x * finalMax + n.x * nMax, 
            y: center.y + u.y * finalMax + n.y * nMax 
        };
        const newV3 = { 
            x: center.x + u.x * finalMin + n.x * nMax, 
            y: center.y + u.y * finalMin + n.y * nMax 
        };

        return {
            ...poly,
            vertices: [newV0, newV1, newV2, newV3]
        };
    });
};

const mergeParallelBeamPolygons = (polys: DxfEntity[]): DxfEntity[] => {
    const merged: DxfEntity[] = [];

    const getDirInfo = (poly: DxfEntity) => {
        if (!poly.vertices || poly.vertices.length < 4) return null;
        const v0 = poly.vertices[0];
        const v1 = poly.vertices[1];
        const v3 = poly.vertices[3];
        const dir = { x: v1.x - v0.x, y: v1.y - v0.y };
        const len = Math.sqrt(dir.x * dir.x + dir.y * dir.y);
        if (len < 1e-3) return null;
        const u = { x: dir.x / len, y: dir.y / len };
        const perp = { x: v3.x - v0.x, y: v3.y - v0.y };
        const w = Math.sqrt(perp.x * perp.x + perp.y * perp.y);
        const n = { x: perp.x / (w || 1), y: perp.y / (w || 1) };
        return { u, n, len, w, origin: v0 };
    };

    const project = (p: Point, origin: Point, axis: Point) => {
        const dx = p.x - origin.x;
        const dy = p.y - origin.y;
        return dx * axis.x + dy * axis.y;
    };

    polys.forEach(poly => {
        const infoA = getDirInfo(poly);
        if (!infoA) {
            merged.push(poly);
            return;
        }

        let mergedIntoExisting = false;

        for (let i = 0; i < merged.length; i++) {
            const m = merged[i];
            const infoB = getDirInfo(m);
            if (!infoB) continue;

            const dot = infoA.u.x * infoB.u.x + infoA.u.y * infoB.u.y;
            if (Math.abs(dot) < 0.98) continue;

            const widthDiff = Math.abs(infoA.w - infoB.w);
            if (widthDiff > Math.max(infoA.w, infoB.w) * 0.2) continue;

            const centerA = getCenter(poly);
            const centerB = getCenter(m);
            if (!centerA || !centerB) continue;
            const offset = Math.abs((centerB.x - centerA.x) * infoA.n.x + (centerB.y - centerA.y) * infoA.n.y);
            if (offset > Math.max(infoA.w, infoB.w) * 0.6) continue;

            const projections = (p: DxfEntity, origin: Point, u: Point) => {
                if (!p.vertices) return { min: 0, max: 0 };
                let min = Infinity, max = -Infinity;
                p.vertices.forEach(v => {
                    const proj = project(v, origin, u);
                    if (proj < min) min = proj;
                    if (proj > max) max = proj;
                });
                return { min, max };
            };

            const projA = projections(poly, infoA.origin, infoA.u);
            const projB = projections(m, infoA.origin, infoA.u);
            const overlap = Math.min(projA.max, projB.max) - Math.max(projA.min, projB.min);
            if (overlap < -50) continue; 

            const minProj = Math.min(projA.min, projB.min);
            const maxProj = Math.max(projA.max, projB.max);
            const width = Math.max(infoA.w, infoB.w);
            const centerPerpA = project(infoA.origin, infoA.origin, infoA.n) + width * 0.5;
            const centerPerpB = project(infoB.origin, infoA.origin, infoA.n) + infoB.w * 0.5;
            const centerPerp = (centerPerpA + centerPerpB) / 2;

            const p0 = {
                x: infoA.origin.x + infoA.u.x * minProj + infoA.n.x * (centerPerp - width / 2),
                y: infoA.origin.y + infoA.u.y * minProj + infoA.n.y * (centerPerp - width / 2)
            };
            const p1 = {
                x: infoA.origin.x + infoA.u.x * maxProj + infoA.n.x * (centerPerp - width / 2),
                y: infoA.origin.y + infoA.u.y * maxProj + infoA.n.y * (centerPerp - width / 2)
            };
            const p2 = {
                x: infoA.origin.x + infoA.u.x * maxProj + infoA.n.x * (centerPerp + width / 2),
                y: infoA.origin.y + infoA.u.y * maxProj + infoA.n.y * (centerPerp + width / 2)
            };
            const p3 = {
                x: infoA.origin.x + infoA.u.x * minProj + infoA.n.x * (centerPerp + width / 2),
                y: infoA.origin.y + infoA.u.y * minProj + infoA.n.y * (centerPerp + width / 2)
            };

            merged[i] = { ...m, vertices: [p0, p1, p2, p3], layer: m.layer };
            mergedIntoExisting = true;
            break;
        }

        if (!mergedIntoExisting) merged.push(poly);
    });

    return merged;
};

const generateBeamSegments = (
    sources: ReturnType<typeof collectBeamSources>,
    resultLayer: string
): BeamSegment[] => {
    const generatedPolygons = findParallelPolygonsBeam(
        sources.lines,
        1200,
        resultLayer,
        sources.obstacles,
        sources.axisLines,
        sources.textPool,
        sources.validWidths,
        sources.lines
    );

    const existingPolygons = sources.polylines.map(p => ({ ...p, layer: resultLayer }));
    let allBeams = [...generatedPolygons, ...existingPolygons];

    allBeams = extendBeamPolygons(allBeams, sources.validWidths, sources.lines, sources.obstacles);
    allBeams = mergeParallelBeamPolygons(allBeams);

    return allBeams
        .filter(ent => getBeamProperties(ent).length > 200)
        .map((ent, idx) => {
            const props = getBeamProperties(ent);
            return {
                ...(ent as DxfEntity),
                layer: resultLayer,
                __beamId: (ent as any).__beamId || `beam-${resultLayer}-${idx}`,
                beamType: (ent as any).beamType || 'UNKNOWN',
                beamLabel: (ent as any).beamLabel || null,
                beamAngle: normalizeAngle(props.angle)
            } as BeamSegment;
        });
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
            
            const v2 = { x: l2.end.x - l2.start.x, y: l2.end.y - l2.start.y };
            const len2 = Math.sqrt(v2.x*v2.x + v2.y*v2.y);
            const dot = (v1.x * v2.x + v1.y * v2.y) / (len1 * len2);
            if (Math.abs(dot) < 0.98) continue;

            const center = { x: (l2.start.x + l2.end.x)/2, y: (l2.start.y + l2.end.y)/2 };
            const dist = distancePointToLine(center, l1.start, l1.end);
            
            if (dist > 50 && dist < 800) {
                const rounded = Math.round(dist / 10) * 10;
                thicknessCounts.set(rounded, (thicknessCounts.get(rounded) || 0) + 1);
            }
        }
    }

    const result = new Set<number>();
    thicknessCounts.forEach((count, thick) => {
        if (count > 2) { 
             const isStandard = VALID_THICKNESSES.some(std => Math.abs(std - thick) <= 5);
             if (isStandard || count > 10) {
                 result.add(thick);
             }
        }
    });
    
    return result;
};

// --- BEAM PIPELINE HELPERS ---

const ensureBeamStageColor = (layer: string, setLayerColors: React.Dispatch<React.SetStateAction<Record<string, string>>>) => {
    setLayerColors(prev => {
        if (prev[layer]) return prev;
        const color = DEFAULT_BEAM_STAGE_COLORS[layer] || '#22c55e';
        return { ...prev, [layer]: color };
    });
};

const attachAttributesToSegments = (segments: BeamSegment[], textPool: DxfEntity[]): BeamSegment[] => {
    const scoredTexts = textPool
        .filter(t => t.start)
        .map(t => ({
            entity: t,
            parsed: parseBeamTypeFromText(t.text)
        }))
        .filter(t => t.parsed.label || t.parsed.type !== 'UNKNOWN');

    return segments.map(seg => {
        const center = getCenter(seg);
        if (!center) return seg;

        let best: { dist: number, label: string | null, type: BeamTypeTag } | null = null;
        scoredTexts.forEach(t => {
            const dist = distance(center, t.entity.start!);
            if (dist > 3500) return;
            if (!best || dist < best.dist) {
                best = { dist, label: t.parsed.label, type: t.parsed.type };
            }
        });

        if (!best) return seg;

        return {
            ...seg,
            beamLabel: seg.beamLabel || best.label,
            beamType: seg.beamType && seg.beamType !== 'UNKNOWN' ? seg.beamType : best.type
        };
    });
};

class UnionFind {
    parent: Map<string, string>;
    constructor(ids: string[]) {
        this.parent = new Map();
        ids.forEach(id => this.parent.set(id, id));
    }
    find(x: string): string {
        const p = this.parent.get(x);
        if (!p) return x;
        if (p === x) return x;
        const root = this.find(p);
        this.parent.set(x, root);
        return root;
    }
    union(a: string, b: string) {
        const ra = this.find(a);
        const rb = this.find(b);
        if (ra === rb) return;
        this.parent.set(rb, ra);
    }
    groups(): Map<string, string[]> {
        const result = new Map<string, string[]>();
        this.parent.forEach((_, k) => {
            const root = this.find(k);
            if (!result.has(root)) result.set(root, []);
            result.get(root)!.push(k);
        });
        return result;
    }
}

interface SegmentInfo {
    id: string;
    segment: BeamSegment;
    bounds: Bounds;
    center: Point;
    orientation: BeamOrientation;
    angle: number;
    length: number;
    width: number;
    type: BeamTypeTag;
    label: string | null;
}

const getSegmentInfo = (seg: BeamSegment): SegmentInfo | null => {
    const bounds = getEntityBounds(seg);
    const center = getCenter(seg);
    if (!bounds || !center) return null;
    const props = getBeamProperties(seg);
    const angle = normalizeAngle(seg.beamAngle ?? props.angle);
    const width = Math.min(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY);
    return {
        id: seg.__beamId,
        segment: seg,
        bounds,
        center,
        orientation: getOrientation(angle),
        angle,
        length: props.length,
        width,
        type: seg.beamType || 'UNKNOWN',
        label: seg.beamLabel || null
    };
};

const detectCrossBlocking = (_infos: SegmentInfo[]) => {
    return new Map<string, Point[]>();
};

const canMergeColinear = (a: SegmentInfo, b: SegmentInfo, blocks: Map<string, Point[]>): boolean => {
    if (a.orientation !== b.orientation) return false;

    const axisTolerance = Math.max(a.width, b.width, 120);
    if (a.orientation === 'H') {
        if (Math.abs(a.center.y - b.center.y) > axisTolerance) return false;
        const minX = Math.min(a.bounds.minX, b.bounds.minX);
        const maxX = Math.max(a.bounds.maxX, b.bounds.maxX);
        const overlap = Math.min(a.bounds.maxX, b.bounds.maxX) - Math.max(a.bounds.minX, b.bounds.minX);
        const gap = overlap >= 0 ? 0 : Math.abs(overlap);
        const allowGap = 400;
        if (gap > allowGap) return false;

        const pts = [...(blocks.get(a.id) || []), ...(blocks.get(b.id) || [])];
        const midY = (a.center.y + b.center.y) / 2;
        const blocked = pts.some(p => p.x >= minX - 10 && p.x <= maxX + 10 && Math.abs(p.y - midY) < axisTolerance);
        return !blocked;
    }

    if (Math.abs(a.center.x - b.center.x) > axisTolerance) return false;
    const minY = Math.min(a.bounds.minY, b.bounds.minY);
    const maxY = Math.max(a.bounds.maxY, b.bounds.maxY);
    const overlap = Math.min(a.bounds.maxY, b.bounds.maxY) - Math.max(a.bounds.minY, b.bounds.minY);
    const gap = overlap >= 0 ? 0 : Math.abs(overlap);
    const allowGap = 400;
    if (gap > allowGap) return false;

    const pts = [...(blocks.get(a.id) || []), ...(blocks.get(b.id) || [])];
    const midX = (a.center.x + b.center.x) / 2;
    const blocked = pts.some(p => p.y >= minY - 10 && p.y <= maxY + 10 && Math.abs(p.x - midX) < axisTolerance);
    return !blocked;
};

const groupBeamSegments = (segments: BeamSegment[]): { groups: Map<string, BeamSegment[]>, info: Map<string, SegmentInfo> } => {
    const infos: SegmentInfo[] = [];
    segments.forEach(seg => {
        const info = getSegmentInfo(seg);
        if (info) infos.push(info);
    });

    const blocks = detectCrossBlocking(infos);
    const uf = new UnionFind(infos.map(i => i.id));

    for (let i = 0; i < infos.length; i++) {
        for (let j = i + 1; j < infos.length; j++) {
            if (canMergeColinear(infos[i], infos[j], blocks)) {
                uf.union(infos[i].id, infos[j].id);
            }
        }
    }

    const groups = new Map<string, BeamSegment[]>();
    const infoMap = new Map<string, SegmentInfo>();
    infos.forEach(info => infoMap.set(info.id, info));

    uf.groups().forEach((ids, root) => {
        const segs = ids.map(id => segments.find(s => s.__beamId === id)!).filter(Boolean);
        groups.set(root, segs);
    });

    return { groups, info: infoMap };
};


// --- LOGIC FUNCTIONS ---

export const runBeamHardSplit = (
    activeProject: ProjectFile, 
    projects: ProjectFile[], 
    setProjects: React.Dispatch<React.SetStateAction<ProjectFile[]>>,
    setLayerColors: React.Dispatch<React.SetStateAction<Record<string, string>>>
) => {
    const sources = collectBeamSources(activeProject, projects);
    if (!sources) return;
    const resultLayer = 'BEAM_STEP1_SEGMENTS';
    const contextLayers = ['WALL', 'COLU', 'AXIS', 'WALL_CALC', 'COLU_CALC', ...sources.beamTextLayers];

    const segments = generateBeamSegments(sources, resultLayer);
    if (segments.length === 0) {
        console.log('No beam segments found for hard split.');
        return;
    }

    ensureBeamStageColor(resultLayer, setLayerColors);
    updateProject(
        activeProject, 
        setProjects, 
        setLayerColors, 
        resultLayer, 
        segments, 
        DEFAULT_BEAM_STAGE_COLORS[resultLayer],
        contextLayers, 
        true
    );
    console.log(`Hard split produced ${segments.length} beam fragments.`);
};

export const runBeamAttributeMounting = (
    activeProject: ProjectFile, 
    projects: ProjectFile[], 
    setProjects: React.Dispatch<React.SetStateAction<ProjectFile[]>>,
    setLayerColors: React.Dispatch<React.SetStateAction<Record<string, string>>>
) => {
    const sources = collectBeamSources(activeProject, projects);
    if (!sources) return;
    const baseSegments = hydrateBeamSegmentsFromLayer(activeProject, 'BEAM_STEP1_SEGMENTS');
    const seedSegments = baseSegments.length > 0 ? baseSegments : generateBeamSegments(sources, 'BEAM_STEP1_SEGMENTS');

    if (seedSegments.length === 0) {
        console.log('No beam segments available for attribute mounting.');
        return;
    }

    const enriched = attachAttributesToSegments(seedSegments, sources.textPool);
    const resultLayer = 'BEAM_STEP2_ATTR';
    const contextLayers = ['AXIS', ...sources.beamTextLayers];

    const newEntities: DxfEntity[] = [];
    enriched.forEach(seg => {
        newEntities.push({ ...(seg as DxfEntity), layer: resultLayer });
        const center = getCenter(seg);
        if (center && (seg.beamLabel || seg.beamType !== 'UNKNOWN')) {
            newEntities.push({
                type: EntityType.TEXT,
                layer: resultLayer,
                start: center,
                text: `${seg.beamLabel || 'UNK'} | ${seg.beamType}`,
                radius: 260,
                startAngle: seg.beamAngle || 0
            });
        }
    });

    ensureBeamStageColor(resultLayer, setLayerColors);
    updateProject(
        activeProject,
        setProjects,
        setLayerColors,
        resultLayer,
        newEntities,
        DEFAULT_BEAM_STAGE_COLORS[resultLayer],
        contextLayers,
        true
    );
    console.log(`Mounted attributes on ${enriched.length} beam fragments.`);
};

export const runBeamTopologyMerge = (
    activeProject: ProjectFile, 
    projects: ProjectFile[], 
    setProjects: React.Dispatch<React.SetStateAction<ProjectFile[]>>,
    setLayerColors: React.Dispatch<React.SetStateAction<Record<string, string>>>
) => {
    const sources = collectBeamSources(activeProject, projects);
    if (!sources) return;
    const stage2Segments = hydrateBeamSegmentsFromLayer(activeProject, 'BEAM_STEP2_ATTR');
    const baseSegments = stage2Segments.length > 0 ? stage2Segments : attachAttributesToSegments(
        hydrateBeamSegmentsFromLayer(activeProject, 'BEAM_STEP1_SEGMENTS').length > 0
            ? hydrateBeamSegmentsFromLayer(activeProject, 'BEAM_STEP1_SEGMENTS')
            : generateBeamSegments(sources, 'BEAM_STEP1_SEGMENTS'),
        sources.textPool
    );

    if (baseSegments.length === 0) {
        console.log('No beam fragments available for topology merge.');
        return;
    }

    const { groups, info } = groupBeamSegments(baseSegments);
    const resultLayer = 'BEAM_STEP3_LOGIC';
    const contextLayers = ['AXIS', 'WALL', 'COLU', ...sources.beamTextLayers];
    const mergedEntities: DxfEntity[] = [];
    let labelIndex = 1;

    groups.forEach((segs, root) => {
        const groupInfos = segs
            .map(s => info.get(s.__beamId))
            .filter((i): i is SegmentInfo => Boolean(i));

        const dominant = groupInfos.reduce((best, curr) => {
            if (!best) return curr;
            const currScore = TYPE_PRIORITY[curr.type] * 10000 + curr.length;
            const bestScore = TYPE_PRIORITY[best.type] * 10000 + best.length;
            return currScore > bestScore ? curr : best;
        }, groupInfos[0] || null);

        const groupType = dominant?.type || 'UNKNOWN';
        const groupLabel = segs.find(s => s.beamLabel)?.beamLabel || dominant?.label || null;
        const center = dominant?.center || getCenter(segs[0]);

        segs.forEach(seg => {
            mergedEntities.push({
                ...(seg as DxfEntity),
                layer: resultLayer,
                beamType: groupType,
                beamLabel: groupLabel
            } as DxfEntity);
        });

        if (center) {
            mergedEntities.push({
                type: EntityType.TEXT,
                layer: resultLayer,
                start: center,
                text: `G${labelIndex} ${groupLabel || ''} (${groupType})`,
                radius: 320,
                startAngle: dominant?.angle || 0
            });
        }
        labelIndex++;
    });

    ensureBeamStageColor(resultLayer, setLayerColors);
    updateProject(
        activeProject,
        setProjects,
        setLayerColors,
        resultLayer,
        mergedEntities,
        DEFAULT_BEAM_STAGE_COLORS[resultLayer],
        contextLayers,
        true
    );
    console.log(`Topology merge produced ${groups.size} beam objects.`);
};

export const runBeamPropagation = (
    activeProject: ProjectFile, 
    projects: ProjectFile[], 
    setProjects: React.Dispatch<React.SetStateAction<ProjectFile[]>>,
    setLayerColors: React.Dispatch<React.SetStateAction<Record<string, string>>>
) => {
    const sources = collectBeamSources(activeProject, projects);
    if (!sources) return;
    let segments = hydrateBeamSegmentsFromLayer(activeProject, 'BEAM_STEP3_LOGIC');

    if (segments.length === 0) {
        runBeamTopologyMerge(activeProject, projects, setProjects, setLayerColors);
        segments = hydrateBeamSegmentsFromLayer(activeProject, 'BEAM_STEP3_LOGIC');
        if (segments.length === 0) {
            console.log('No beam objects available for propagation.');
            return;
        }
    }

    const { groups, info } = groupBeamSegments(segments);

    type GroupMeta = {
        id: string;
        segs: BeamSegment[];
        orientation: BeamOrientation;
        center: Point;
        label: string | null;
        type: BeamTypeTag;
    };

    const metas: GroupMeta[] = [];
    groups.forEach((segs, root) => {
        const center = getCenter(segs[0]);
        const infoItem = info.get(segs[0].__beamId);
        const orientation = infoItem ? infoItem.orientation : 'H';
        const labelSeg = segs.find(s => s.beamLabel);
        const dominantType = segs.reduce<BeamTypeTag>((acc, s) => {
            const candidate = s.beamType || 'UNKNOWN';
            return TYPE_PRIORITY[candidate] > TYPE_PRIORITY[acc] ? candidate : acc;
        }, 'UNKNOWN');

        metas.push({
            id: root,
            segs,
            orientation,
            center: center || { x: 0, y: 0 },
            label: labelSeg?.beamLabel || null,
            type: labelSeg?.beamType || dominantType
        });
    });

    const labeled = metas.filter(m => m.label);
    const unlabeled = metas.filter(m => !m.label);

    unlabeled.forEach(group => {
        const candidates = labeled.filter(l => l.orientation === group.orientation);
        let best: { dist: number, meta: typeof candidates[number] } | null = null;
        candidates.forEach(c => {
            const axisDist = group.orientation === 'H'
                ? Math.abs(c.center.y - group.center.y)
                : Math.abs(c.center.x - group.center.x);
            if (axisDist > 500) return;
            const alongDist = distance(c.center, group.center);
            if (!best || alongDist < best.dist) {
                best = { dist: alongDist, meta: c };
            }
        });

        if (best) {
            group.label = best.meta.label;
            group.type = best.meta.type;
        }
    });

    const resultLayer = 'BEAM_STEP4_PROP';
    const contextLayers = ['AXIS', 'WALL', 'COLU', ...sources.beamTextLayers];
    const propagatedEntities: DxfEntity[] = [];

    metas.forEach(meta => {
        meta.segs.forEach(seg => {
            propagatedEntities.push({
                ...(seg as DxfEntity),
                layer: resultLayer,
                beamType: meta.type,
                beamLabel: meta.label || seg.beamLabel
            } as DxfEntity);
        });

        const center = meta.center;
        propagatedEntities.push({
            type: EntityType.TEXT,
            layer: resultLayer,
            start: center,
            text: `${meta.label || 'UNLABELED'} (${meta.type})`,
            radius: 340,
            startAngle: 0
        });
    });

    ensureBeamStageColor(resultLayer, setLayerColors);
    updateProject(
        activeProject,
        setProjects,
        setLayerColors,
        resultLayer,
        propagatedEntities,
        DEFAULT_BEAM_STAGE_COLORS[resultLayer],
        contextLayers,
        true
    );
    console.log(`Propagation finished. Groups labeled: ${metas.filter(m => m.label).length}/${metas.length}.`);
};

export const runCalculateBeams = (
    activeProject: ProjectFile, 
    projects: ProjectFile[], 
    setProjects: React.Dispatch<React.SetStateAction<ProjectFile[]>>,
    setLayerColors: React.Dispatch<React.SetStateAction<Record<string, string>>>
) => {
    runBeamHardSplit(activeProject, projects, setProjects, setLayerColors);
    runBeamAttributeMounting(activeProject, projects, setProjects, setLayerColors);
    runBeamTopologyMerge(activeProject, projects, setProjects, setLayerColors);
    runBeamPropagation(activeProject, projects, setProjects, setLayerColors);
};
export const runCalculateWalls = (
    activeProject: ProjectFile, 
    projects: ProjectFile[], 
    setProjects: React.Dispatch<React.SetStateAction<ProjectFile[]>>,
    setLayerColors: React.Dispatch<React.SetStateAction<Record<string, string>>>
) => {
    const baseBounds = getMergeBaseBounds(activeProject, 2500);

    const targetLayers = activeProject.data.layers.filter(l => /wall/i.test(l));
    
    let columnObstacles = findEntitiesInAllProjects(projects, /colu|column/i);
    const calcColumns = extractEntities(['COLU_CALC'], activeProject.data.entities, activeProject.data.blocks, activeProject.data.blockBasePoints);
    columnObstacles = [...columnObstacles, ...calcColumns];
    columnObstacles = filterEntitiesInBounds(columnObstacles, baseBounds);

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

    const estimatedWidths = estimateWallThicknesses(candidateLines);
    if (estimatedWidths.size === 0) {
        estimatedWidths.add(200);
        estimatedWidths.add(240);
        estimatedWidths.add(100);
    }
    const widthStr = Array.from(estimatedWidths).join(', ');

    const generatedWalls = findParallelPolygonsWall(candidateLines, 600, resultLayer, columnObstacles, axisLines, [], estimatedWidths);
    
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
    const targetLayers = activeProject.data.layers.filter(l => /colu|column/i.test(l));
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
            start: {
                x: (box.minX + box.maxX) / 2,
                y: box.minY - 3000
            },
            radius: 1200
        });

        scannedBounds.forEach((b, idx) => {
             debugEntities.push({
                 type: EntityType.LWPOLYLINE,
                 layer: debugLayer,
                 closed: true,
                 vertices: [
                    { x: b.minX, y: b.minY },
                    { x: b.maxX, y: b.minY },
                    { x: b.maxX, y: b.maxY },
                    { x: b.minX, y: b.maxY }
                 ]
             });
        });
    });
    
    regions.sort((a, b) => {
        if (a.info && b.info) {
             return a.info.index - b.info.index;
        }
        return b.bounds.minY - a.bounds.minY;
    });

    if (regions.length > 0) {
        updateProject(activeProject, setProjects, setLayerColors, resultLayer, newEntities, '#8b5cf6', axisLayers, false, regions);
        console.log(`Detected ${regions.length} split regions.`);
        return regions;
    } else {
        if (!suppressAlert) console.log("Failed to detect valid regions.");
        return null;
    }
};

export const runMergeViews = (
    activeProject: ProjectFile,
    setProjects: React.Dispatch<React.SetStateAction<ProjectFile[]>>,
    setLayerColors: React.Dispatch<React.SetStateAction<Record<string, string>>>
) => {
    let regions = activeProject.splitRegions;
    if (!regions) {
        regions = runCalculateSplitRegions(activeProject, setProjects, setLayerColors, true);
    }
    
    if (!regions || regions.length < 2) {
        console.log("Merge requires at least 2 detected regions.");
        return;
    }

    const sorted = [...regions].sort((a, b) => {
        const idxA = a.info ? a.info.index : 999;
        const idxB = b.info ? b.info.index : 999;
        return idxA - idxB;
    });

    const axisLayers = activeProject.data.layers.filter(l => l.toUpperCase().includes('AXIS'));
    const allAxisLines = extractEntities(axisLayers, activeProject.data.entities, activeProject.data.blocks, activeProject.data.blockBasePoints)
        .filter(e => e.type === EntityType.LINE && e.start && e.end);

    const baseRegion = sorted[0];
    const baseGrid = getGridIntersections(baseRegion.bounds, allAxisLines);

    if (baseGrid.length < 1) {
        console.log("Base region has no detected grid intersections.");
        return;
    }

    const mergedEntities: DxfEntity[] = [];
    const mergeDebugLayer = 'MERGE_DEBUG';
    const mergeLabelLayer = 'MERGE_LABEL';

    const baseEntities = filterEntitiesInBounds(activeProject.data.entities, [baseRegion.bounds]);
    mergedEntities.push(...baseEntities);
    
    mergedEntities.push({
        type: EntityType.TEXT,
        layer: mergeLabelLayer,
        start: { x: (baseRegion.bounds.minX + baseRegion.bounds.maxX)/2, y: baseRegion.bounds.minY - 2000 },
        text: baseRegion.title,
        radius: 1000
    });

    for (let i = 1; i < sorted.length; i++) {
        const target = sorted[i];
        const targetGrid = getGridIntersections(target.bounds, allAxisLines);

        if (targetGrid.length < 1) {
            console.log(`Region ${target.title} has no grid intersections. Skipping.`);
            continue;
        }

        const vec = calculateMergeVector(baseGrid, targetGrid);
        
        if (vec) {
            const targetEntities = filterEntitiesInBounds(activeProject.data.entities, [target.bounds]);
            
            targetEntities.forEach(ent => {
                 const copy = { ...ent };
                 if (copy.start) copy.start = { x: copy.start.x + vec.x, y: copy.start.y + vec.y };
                 if (copy.end) copy.end = { x: copy.end.x + vec.x, y: copy.end.y + vec.y };
                 if (copy.center) copy.center = { x: copy.center.x + vec.x, y: copy.center.y + vec.y };
                 if (copy.vertices) copy.vertices = copy.vertices.map(v => ({ x: v.x + vec.x, y: v.y + vec.y }));
                 if (copy.measureStart) copy.measureStart = { x: copy.measureStart.x + vec.x, y: copy.measureStart.y + vec.y };
                 if (copy.measureEnd) copy.measureEnd = { x: copy.measureEnd.x + vec.x, y: copy.measureEnd.y + vec.y };
                 
                 mergedEntities.push(copy);
            });

            mergedEntities.push({
                type: EntityType.TEXT,
                layer: mergeLabelLayer,
                start: { x: (target.bounds.minX + target.bounds.maxX)/2 + vec.x, y: target.bounds.minY - 2000 + vec.y },
                text: target.title,
                radius: 1000
            });

            console.log(`Merged ${target.title} using vector [${vec.x}, ${vec.y}]`);
        } else {
            console.log(`Could not find merge vector for ${target.title}`);
        }
    }

    const resultLayer = 'MERGE_RESULT';
    const contextLayers = [...activeProject.data.layers, mergeLabelLayer];
    
    ensureBeamStageColor(mergeLabelLayer, setLayerColors);
    updateProject(activeProject, setProjects, setLayerColors, resultLayer, mergedEntities, '#f472b6', contextLayers, false);
};