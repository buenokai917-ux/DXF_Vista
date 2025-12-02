import React from 'react';
import { DxfEntity, EntityType, Point, Bounds, ProjectFile } from '../types';
import { extractEntities } from '../utils/dxfHelpers';
import { updateProject, getMergeBaseBounds, findEntitiesInAllProjects, isEntityInBounds, filterEntitiesInBounds, isPointInBounds } from './structure-common';
import {
    getBeamProperties,
    getCenter,
    getEntityBounds,
    distance,
    boundsOverlap,
    findParallelPolygons
} from '../utils/geometryUtils';

// --- TYPES & CONSTANTS ---

export type BeamTypeTag = 'MAIN' | 'SECONDARY' | 'UNKNOWN';

interface BeamSegment extends DxfEntity {
    __beamId: string;
    beamType?: BeamTypeTag;
    beamLabel?: string | null;
    beamAngle?: number;
}

const BEAM_LAYER_CANDIDATES = ['BEAM', 'BEAM_CON'];
const DEFAULT_BEAM_STAGE_COLORS: Record<string, string> = {
    BEAM_STEP1_RAW: '#10b981',      // Green
    BEAM_STEP2_GEO: '#06b6d4',      // Cyan
    BEAM_STEP3_ATTR: '#f59e0b',     // Amber
    BEAM_STEP4_LOGIC: '#8b5cf6',    // Violet
    BEAM_STEP5_PROP: '#ec4899',     // Pink
    BEAM_CALC: '#00FF00'
};

// --- HELPERS ---

// Robust Deep Copy
const deepCopyEntities = (entities: DxfEntity[]): DxfEntity[] => {
    return JSON.parse(JSON.stringify(entities));
};

const collectBeamSources = (
    activeProject: ProjectFile,
    projects: ProjectFile[]
) => {
    if (!activeProject.splitRegions || activeProject.splitRegions.length === 0) {
        alert('Please run "Split Views" first.');
        return null;
    }

    const baseBounds = getMergeBaseBounds(activeProject, 2500);

    // 1. Find Annotation Layers
    const beamTextLayers = activeProject.data.layers.filter(l => {
        const u = l.toUpperCase();
        if (u.endsWith('_CALC')) return false;
        if (/^Z.*梁/i.test(u)) return true;
        if (u.includes('标注') && u.includes('梁')) return true;
        if (u.includes('DIM') && u.includes('BEAM')) return true;
        if (u === 'MERGE_LABEL') return true;
        return false;
    });

    const beamLayers = BEAM_LAYER_CANDIDATES;

    let rawEntities = extractEntities(beamLayers, activeProject.data.entities, activeProject.data.blocks, activeProject.data.blockBasePoints);
    let rawTextEntities = extractEntities(beamTextLayers, activeProject.data.entities, activeProject.data.blocks, activeProject.data.blockBasePoints)
        .filter(e => e.type === EntityType.TEXT && !e.layer.toUpperCase().startsWith('Z_'));

    const entities = filterEntitiesInBounds(rawEntities, baseBounds);
    const textEntities = filterEntitiesInBounds(rawTextEntities, baseBounds);

    // Axis Lines
    const axisLayers = activeProject.data.layers.filter(l => l.toUpperCase().includes('AXIS'));
    const rawAxis = extractEntities(axisLayers, activeProject.data.entities, activeProject.data.blocks, activeProject.data.blockBasePoints);
    const axisLines = filterEntitiesInBounds(rawAxis, baseBounds);

    // 2. Obstacles (Walls and Columns)
    let walls: DxfEntity[] = [];
    const wallCalcLayer = activeProject.data.layers.find(l => l === 'WALL_CALC');
    if (wallCalcLayer) {
        walls = extractEntities([wallCalcLayer], activeProject.data.entities, activeProject.data.blocks, activeProject.data.blockBasePoints);
    } else {
        const rawWallLayers = activeProject.data.layers.filter(l => /wall|墙/i.test(l) && !l.endsWith('_CALC'));
        walls = extractEntities(rawWallLayers, activeProject.data.entities, activeProject.data.blocks, activeProject.data.blockBasePoints);
    }
    walls = filterEntitiesInBounds(walls, baseBounds);

    let cols: DxfEntity[] = [];
    const colCalcLayer = activeProject.data.layers.find(l => l === 'COLU_CALC');
    if (colCalcLayer) {
        cols = extractEntities([colCalcLayer], activeProject.data.entities, activeProject.data.blocks, activeProject.data.blockBasePoints);
    } else {
        const rawColLayers = activeProject.data.layers.filter(l => /colu|column|柱/i.test(l) && !l.endsWith('_CALC'));
        cols = extractEntities(rawColLayers, activeProject.data.entities, activeProject.data.blocks, activeProject.data.blockBasePoints);
    }
    cols = filterEntitiesInBounds(cols, baseBounds);

    if (cols.length < 5) {
        // Fallback: Check global projects if local columns are missing
        const globalCols = findEntitiesInAllProjects(projects, /colu|column|柱/i);
        cols = filterEntitiesInBounds(globalCols, baseBounds);
    }

    const obstacles = [...walls, ...cols];

    // 3. Valid Widths (From Text)
    const validWidths = new Set<number>();
    textEntities.forEach(t => {
        if (!t.text) return;
        const matches = t.text.match(/^.+\s+(\d+)[xX×]\d+/);
        if (matches) {
            const w = parseInt(matches[1], 10);
            if (!isNaN(w) && w >= 100 && w <= 2000) validWidths.add(w);
        } else {
            const simpleMatch = t.text.match(/^(\d+)[xX×]\d+$/);
            if (simpleMatch) {
                const w = parseInt(simpleMatch[1], 10);
                if (!isNaN(w) && w >= 100 && w <= 2000) validWidths.add(w);
            }
        }
    });

    return {
        baseBounds,
        obstacles,
        validWidths,
        lines: entities,
        axisLines,
        textPool: textEntities
    };
};

// --- GEOMETRIC HELPERS ---

interface OBB {
    center: Point;
    u: Point; // Longitudinal Axis
    v: Point; // Transverse Axis
    halfLen: number;
    halfWidth: number;
    minT: number; // min along U from center
    maxT: number; // max along U from center
    entity: DxfEntity;
}

const computeOBB = (poly: DxfEntity): OBB | null => {
    if (!poly.vertices || poly.vertices.length < 4) return null;
    const center = getCenter(poly);
    if (!center) return null;

    const p0 = poly.vertices[0];
    const p1 = poly.vertices[1];
    const p3 = poly.vertices[3];
    if (!p0 || !p1 || !p3) return null;

    const v01 = { x: p1.x - p0.x, y: p1.y - p0.y };
    const v03 = { x: p3.x - p0.x, y: p3.y - p0.y };
    const len01 = Math.sqrt(v01.x * v01.x + v01.y * v01.y);
    const len03 = Math.sqrt(v03.x * v03.x + v03.y * v03.y);

    let u: Point, v: Point, len: number, width: number;
    // Assume longer side is length (Beam axis)
    if (len01 > len03) {
        if (len01 === 0) return null;
        u = { x: v01.x / len01, y: v01.y / len01 };
        v = { x: v03.x / len03, y: v03.y / len03 };
        len = len01;
        width = len03;
    } else {
        if (len03 === 0) return null;
        u = { x: v03.x / len03, y: v03.y / len03 };
        v = { x: v01.x / len01, y: v01.y / len01 };
        len = len03;
        width = len01;
    }

    // Normalize U to point roughly East or South to ensure consistent direction for sorting
    if (u.x < -0.001 || (Math.abs(u.x) < 0.001 && u.y < -0.001)) {
        u = { x: -u.x, y: -u.y };
        v = { x: -v.x, y: -v.y }; // Flip V to keep handedness? Actually OBB V direction doesn't matter much for projection magnitude
    }

    const project = (p: Point) => (p.x - center.x) * u.x + (p.y - center.y) * u.y;
    let minT = Infinity, maxT = -Infinity;
    poly.vertices.forEach(vert => {
        if (!vert) return;
        const t = project(vert);
        minT = Math.min(minT, t);
        maxT = Math.max(maxT, t);
    });

    return { center, u, v, halfLen: len / 2, halfWidth: width / 2, minT, maxT, entity: poly };
};

const rayIntersectsAABB = (origin: Point, dir: Point, bounds: Bounds): { tmin: number, tmax: number } => {
    let tmin = -Infinity;
    let tmax = Infinity;

    if (!origin || !dir) return { tmin: Infinity, tmax: -Infinity };

    // X-Axis
    if (Math.abs(dir.x) > 1e-9) {
        const t1 = (bounds.minX - origin.x) / dir.x;
        const t2 = (bounds.maxX - origin.x) / dir.x;
        tmin = Math.max(tmin, Math.min(t1, t2));
        tmax = Math.min(tmax, Math.max(t1, t2));
    } else if (origin.x < bounds.minX || origin.x > bounds.maxX) {
        return { tmin: Infinity, tmax: -Infinity };
    }

    // Y-Axis
    if (Math.abs(dir.y) > 1e-9) {
        const t1 = (bounds.minY - origin.y) / dir.y;
        const t2 = (bounds.maxY - origin.y) / dir.y;
        tmin = Math.max(tmin, Math.min(t1, t2));
        tmax = Math.min(tmax, Math.max(t1, t2));
    } else if (origin.y < bounds.minY || origin.y > bounds.maxY) {
        return { tmin: Infinity, tmax: -Infinity };
    }

    return { tmin, tmax };
};

// --- CORE INTERSECTION LOGIC ---

/**
 * 1. Merge Collinear Beams (Step 2a)
 * Strict logic: Only merge if aligned, same width, and Gap is empty/valid.
 * 
 * @param polys Input beam polygons
 * @param obstacles Walls and Columns
 * @param maxGap Max allowable gap to bridge (Step 1: ~0, Step 2: large)
 */
const mergeCollinearBeams = (polys: DxfEntity[], obstacles: DxfEntity[], maxGap: number): DxfEntity[] => {
    const items = polys.map(p => {
        const obb = computeOBB(p);
        return { poly: p, obb };
    }).filter(i => i.obb !== null) as { poly: DxfEntity, obb: OBB }[];

    // Pre-calculate obstacle bounds for fast lookup
    const obsBounds = obstacles.map(o => getEntityBounds(o)).filter(b => b !== null) as Bounds[];

    // Sort to optimize adjacency check
    // We sort primarily by "Lane" (transverse position) then by "Longitudinal" position
    items.sort((a, b) => {
        const isVa = Math.abs(a.obb.u.y) > Math.abs(a.obb.u.x);
        const laneA = isVa ? a.obb.center.x : a.obb.center.y;
        const laneB = isVa ? b.obb.center.x : b.obb.center.y;
        if (Math.abs(laneA - laneB) > 50) return laneA - laneB;
        
        const posA = isVa ? a.obb.center.y : a.obb.center.x;
        const posB = isVa ? b.obb.center.y : b.obb.center.x;
        return posA - posB;
    });

    const mergedPolys: DxfEntity[] = [];
    const used = new Set<number>();

    // Helper to check if a specific gap region is blocked by any obstacle
    const isGapBlocked = (pStart: Point, pEnd: Point, width: number): boolean => {
        // Construct a bounding box for the gap
        const minX = Math.min(pStart.x, pEnd.x) - 5; // buffer
        const maxX = Math.max(pStart.x, pEnd.x) + 5;
        const minY = Math.min(pStart.y, pEnd.y) - 5;
        const maxY = Math.max(pStart.y, pEnd.y) + 5;
        
        // Expand by width/2 in transverse direction roughly
        // To be safe, we just check intersection of the AABB of the gap with obstacle AABBs
        // A simple AABB check is often enough if aligned.
        // For rotated beams, this is loose but safe (might block legitimate merges near corners).
        
        const gapBounds: Bounds = { 
            minX: minX - (width/2), maxX: maxX + (width/2), 
            minY: minY - (width/2), maxY: maxY + (width/2) 
        };

        for (const obs of obsBounds) {
            if (boundsOverlap(gapBounds, obs)) {
                // Precise check: If touching (Gap ~ 0), we check if the junction point is inside obstacle
                const d = distance(pStart, pEnd);
                if (d < 10) {
                     // Check center of junction
                     const mid = { x: (pStart.x + pEnd.x)/2, y: (pStart.y + pEnd.y)/2 };
                     if (isPointInBounds(mid, obs)) return true;
                } else {
                     return true;
                }
            }
        }
        return false;
    };

    const mergeOBBs = (a: OBB, b: OBB): OBB => {
        const u = a.u;
        const project = (p: Point) => (p.x - a.center.x)*u.x + (p.y - a.center.y)*u.y;
        
        const minA = a.minT; 
        const maxA = a.maxT;
        // Project b center onto a's axis
        const centerRel = (b.center.x - a.center.x)*u.x + (b.center.y - a.center.y)*u.y;
        const minB = centerRel + b.minT;
        const maxB = centerRel + b.maxT;
        
        const newMin = Math.min(minA, minB);
        const newMax = Math.max(maxA, maxB);
        const newLen = newMax - newMin;
        const newCenterU = newMin + newLen/2;
        
        const center = {
            x: a.center.x + u.x * newCenterU,
            y: a.center.y + u.y * newCenterU
        };
        
        const halfWidth = Math.max(a.halfWidth, b.halfWidth);
        
        return {
            center, u, v: a.v, halfWidth,
            halfLen: newLen/2, minT: -newLen/2, maxT: newLen/2,
            entity: a.entity
        };
    };

    for (let i = 0; i < items.length; i++) {
        if (used.has(i)) continue;
        let current = items[i].obb;
        let layer = items[i].poly.layer;
        used.add(i);

        let mergedSomething = true;
        while (mergedSomething) {
            mergedSomething = false;
            // Only look ahead a bit since we sorted
            for (let j = i + 1; j < items.length; j++) {
                if (used.has(j)) continue;
                const next = items[j].obb;
                
                // 1. Orientation Check
                const dot = Math.abs(current.u.x * next.u.x + current.u.y * next.u.y);
                if (dot < 0.98) continue; // Must be parallel

                // 2. Lane Check (Transverse distance)
                const perpDist = Math.abs((next.center.x - current.center.x) * current.v.x + (next.center.y - current.center.y) * current.v.y);
                if (perpDist > 50) continue; // Different lanes

                // 3. Gap Check
                // Calculate distance along U axis
                const distAlong = (next.center.x - current.center.x) * current.u.x + (next.center.y - current.center.y) * current.u.y;
                
                // Current Range: [minT, maxT]
                // Next Range: [distAlong + minT, distAlong + maxT]
                const nextStartT = distAlong + next.minT;
                const gap = nextStartT - current.maxT;

                if (gap > maxGap + 10) {
                     // Since sorted, if gap is huge, we might not find closer ones easily, 
                     // but we continue just in case list order is slightly off due to minor misalignments
                     continue; 
                }

                // If overlapping (gap < 0), logic should handle it (merge union)
                // If gap > 0 but < maxGap, we proceed to check obstacles.

                // 4. Width Check
                if (Math.abs(current.halfWidth - next.halfWidth) * 2 > 100) continue;

                // 5. Obstacle Check (CRITICAL)
                // Calculate world points of the "Gap"
                const pEndCurrent = { 
                    x: current.center.x + current.u.x * current.maxT, 
                    y: current.center.y + current.u.y * current.maxT 
                };
                const pStartNext = { 
                    x: current.center.x + current.u.x * nextStartT, 
                    y: current.center.y + current.u.y * nextStartT 
                };

                if (isGapBlocked(pEndCurrent, pStartNext, current.halfWidth * 2)) {
                    continue; // Blocked by wall/column
                }

                // MERGE
                current = mergeOBBs(current, next);
                used.add(j);
                mergedSomething = true;
                
                // Restart inner loop to merge recursively with new extended bounds
                break; 
            }
        }

        // Reconstruct Polyline from OBB
        const { center, u, v, halfWidth, minT, maxT } = current;
        const p1 = { x: center.x + u.x * minT + v.x * halfWidth, y: center.y + u.y * minT + v.y * halfWidth };
        const p2 = { x: center.x + u.x * minT - v.x * halfWidth, y: center.y + u.y * minT - v.y * halfWidth };
        const p3 = { x: center.x + u.x * maxT - v.x * halfWidth, y: center.y + u.y * maxT - v.y * halfWidth };
        const p4 = { x: center.x + u.x * maxT + v.x * halfWidth, y: center.y + u.y * maxT + v.y * halfWidth };
        
        mergedPolys.push({
            type: EntityType.LWPOLYLINE,
            layer,
            closed: true,
            vertices: [p1, p2, p3, p4]
        });
    }

    return mergedPolys;
};

// 2. Extend Beams Perpendicularly (Step 2b) - T-Stem Extension
// PRIORITY 1: Viewport Boundary. Never exceed.
// PRIORITY 2: Wall/Column. Stop immediately.
// PRIORITY 3: Beam. Extend to form T-Junction.
const extendBeamsToPerpendicular = (
    polys: DxfEntity[], 
    targets: DxfEntity[], 
    blockers: DxfEntity[],
    maxSearchDist: number,
    viewports: Bounds[] // Strictly enforce these boundaries
): DxfEntity[] => {
    // Pre-compute bounds
    const blockerBounds = blockers.map(b => getEntityBounds(b)).filter(b => b !== null) as Bounds[];
    const targetOBBs = targets.map(p => computeOBB(p)).filter(o => o !== null) as OBB[];

    return polys.map(poly => {
        const obb = computeOBB(poly);
        if (!obb) return poly;
        const { center, u, v, halfWidth, minT, maxT } = obb;

        // Vertices of the beam ends (Left, Center, Right rays)
        const pFrontLeft = { x: center.x + u.x * maxT + v.x * halfWidth, y: center.y + u.y * maxT + v.y * halfWidth };
        const pFrontRight = { x: center.x + u.x * maxT - v.x * halfWidth, y: center.y + u.y * maxT - v.y * halfWidth };
        const pFrontCenter = { x: center.x + u.x * maxT, y: center.y + u.y * maxT };

        const pBackLeft = { x: center.x + u.x * minT + v.x * halfWidth, y: center.y + u.y * minT + v.y * halfWidth };
        const pBackRight = { x: center.x + u.x * minT - v.x * halfWidth, y: center.y + u.y * minT - v.y * halfWidth };
        const pBackCenter = { x: center.x + u.x * minT, y: center.y + u.y * minT };

        // Identify which viewport contains this beam (use Center Point)
        const containingViewport = viewports.find(vp => isPointInBounds(center, vp));

        const getSafeExtension = (origins: Point[], dir: Point): number => {
            // 1. Viewport Hard Limit
            let viewportLimit = Infinity;
            if (containingViewport) {
                for (const org of origins) {
                    const { tmax } = rayIntersectsAABB(org, dir, containingViewport);
                    // tmax is distance to exit the viewport in direction 'dir'
                    // If tmax > 0, that's the remaining space. If < 0, we are outside (should be 0)
                    if (tmax > -1e-3) {
                        viewportLimit = Math.min(viewportLimit, Math.max(0, tmax));
                    } else {
                        // Origin is outside or on edge pointing out
                        viewportLimit = 0;
                    }
                }
            }

            // 2. Obstacle Limit
            let barrierDist = viewportLimit;

            for (const b of blockerBounds) {
                // Check all 3 rays to prevent corner penetration
                for (const org of origins) {
                    const { tmin, tmax } = rayIntersectsAABB(org, dir, b);
                    // tmax > 0 means the box is "forward" relative to ray (or we are inside it)
                    if (tmax > -1e-3) { 
                         // If we are inside (tmin < 0), distance is 0.
                         // If we are outside, distance is tmin.
                         const dist = Math.max(0, tmin);
                         if (dist < barrierDist) barrierDist = dist;
                    }
                }
            }

            // HIGHEST PRIORITY: If we are touching a wall/column, STOP immediately.
            if (barrierDist < 10) return 0;

            // 3. Beam Target Search
            // Search limit is restricted by maxSearchDist AND the nearest barrier.
            const searchLimit = Math.min(maxSearchDist, barrierDist);
            let bestExtension = 0;

            for (const t of targetOBBs) {
                if (t.entity === poly) continue;
                // Check Perpendicularity (Cross/T Logic)
                if (Math.abs(u.x * t.u.x + u.y * t.u.y) > 0.1) continue; 

                let targetHitMin = Infinity;
                let targetHitMax = -Infinity;
                let hitCount = 0;

                const tBounds = getEntityBounds(t.entity);
                if (!tBounds) continue;

                for (const org of origins) {
                    const { tmin, tmax } = rayIntersectsAABB(org, dir, tBounds);
                    if (tmax > 0 && tmin < searchLimit) {
                         targetHitMin = Math.min(targetHitMin, tmin);
                         targetHitMax = Math.max(targetHitMax, tmax);
                         hitCount++;
                    }
                }

                if (hitCount > 0) {
                     // We hit a target.
                     // We want to extend to the far side of the target (targetHitMax) to form a T-junction.
                     // But we MUST NOT exceed barrierDist.
                     const desired = targetHitMax;
                     if (desired <= barrierDist + 10) { 
                         // Safe to extend fully across target
                         if (desired > bestExtension) bestExtension = Math.min(desired, barrierDist);
                     } else {
                         // Target is cut by wall, or overlaps wall. 
                         // Extend only to wall.
                         if (barrierDist > bestExtension) bestExtension = barrierDist;
                     }
                }
            }
            
            return bestExtension;
        };

        const extFront = getSafeExtension([pFrontLeft, pFrontCenter, pFrontRight], u);
        const extBack = getSafeExtension([pBackLeft, pBackCenter, pBackRight], { x: -u.x, y: -u.y });

        if (extFront === 0 && extBack === 0) return poly;

        const newMaxT = maxT + extFront;
        const newMinT = minT - extBack;
        
        // Reconstruct vertices
        const nP1 = { x: center.x + u.x * newMinT + v.x * halfWidth, y: center.y + u.y * newMinT + v.y * halfWidth };
        const nP2 = { x: center.x + u.x * newMinT - v.x * halfWidth, y: center.y + u.y * newMinT - v.y * halfWidth };
        const nP3 = { x: center.x + u.x * newMaxT - v.x * halfWidth, y: center.y + u.y * newMaxT - v.y * halfWidth };
        const nP4 = { x: center.x + u.x * newMaxT + v.x * halfWidth, y: center.y + u.y * newMaxT + v.y * halfWidth };

        return {
            type: EntityType.LWPOLYLINE,
            layer: poly.layer,
            closed: true,
            vertices: [nP1, nP2, nP3, nP4]
        };
    });
};


// --- EXPORTED PIPELINE STEPS ---

export const runBeamRawGeneration = (
    activeProject: ProjectFile,
    projects: ProjectFile[],
    setProjects: React.Dispatch<React.SetStateAction<ProjectFile[]>>,
    setLayerColors: React.Dispatch<React.SetStateAction<Record<string, string>>>
) => {
    
    const sources = collectBeamSources(activeProject, projects);
    if (!sources) return;
    
    const resultLayer = 'BEAM_STEP1_RAW';
    
    // We pass 'validWidths' to finding algorithm to improve accuracy
    const { lines, obstacles, axisLines, textPool, validWidths } = sources;
    
    const widthsToUse = validWidths.size > 0 ? validWidths : new Set([200, 250, 300, 350, 400, 500, 600]);

    const polys = findParallelPolygons(
        lines, 
        1200, 
        resultLayer, 
        obstacles, 
        axisLines, 
        textPool, 
        'BEAM', 
        widthsToUse
    );

    if (polys.length === 0) {
        console.log("No beam segments found.");
        return;
    }

    // NEW STEP: Merge strictly adjacent/touching segments
    // Requirement: "Start point is end point". We use maxGap=2mm to handle floating point noise.
    // If strict touching is desired, gap <= 2mm is appropriate for CAD data.
    const mergedPolys = mergeCollinearBeams(polys, obstacles, 2);
    
    updateProject(activeProject, setProjects, setLayerColors, resultLayer, mergedPolys, DEFAULT_BEAM_STAGE_COLORS[resultLayer], ['AXIS'], true);
    console.log(`Step 1: Generated ${mergedPolys.length} raw beam segments (merged from ${polys.length}).`);
};


export const runBeamIntersectionProcessing = (
    activeProject: ProjectFile,
    projects: ProjectFile[],
    setProjects: React.Dispatch<React.SetStateAction<ProjectFile[]>>,
    setLayerColors: React.Dispatch<React.SetStateAction<Record<string, string>>>
) => {
    // 1. Get Sources & Valid Widths
    const sources = collectBeamSources(activeProject, projects);
    if (!sources) return;

    const sourceLayer = 'BEAM_STEP1_RAW';
    const resultLayer = 'BEAM_STEP2_GEO';

    // 2. Fetch Step 1 Data (Strict Deep Copy)
    const rawStep1 = activeProject.data.entities.filter(e => e.layer === sourceLayer);
    if (rawStep1.length === 0) {
        alert("Please run Step 1 (Raw Generation) first.");
        return;
    }
    
    const workingSet = deepCopyEntities(rawStep1);
    
    // 3. Define Valid Widths for Limits
    const validWidthsArr = Array.from(sources.validWidths);
    const maxSearchWidth = validWidthsArr.length > 0 ? Math.max(...validWidthsArr) : 600;

    // 4. Retrieve Strict Viewport Boundaries
    // These are unexpanded bounds, representing the exact drawing frames.
    const strictViewports = activeProject.splitRegions ? activeProject.splitRegions.map(r => r.bounds) : [];

    console.log(`Step 2: Processing ${workingSet.length} segments. Max Search Dist: ${maxSearchWidth}. Viewports: ${strictViewports.length}`);

    // 5. Merge Collinear/Adjacent (Step 2a) - Handles Cross merging and T-Top merging
    // Here we DO want to jump gaps (up to maxSearchWidth) to bridge crossing beams.
    // But we strictly stop at walls/columns (handled by the isGapBlocked check in mergeCollinearBeams).
    const merged = mergeCollinearBeams(workingSet, sources.obstacles, maxSearchWidth);
    
    // 6. Extend T-Stems (Step 2b)
    // Priority: Viewports > Walls/Cols > Beams. 
    const extended = extendBeamsToPerpendicular(merged, merged, sources.obstacles, maxSearchWidth, strictViewports);

    // 7. Final cleanup (assign layer)
    const finalEntities = extended.map(e => ({ ...e, layer: resultLayer }));

    updateProject(activeProject, setProjects, setLayerColors, resultLayer, finalEntities, DEFAULT_BEAM_STAGE_COLORS[resultLayer], ['AXIS', 'COLU_CALC', 'WALL_CALC'], true, undefined, [sourceLayer]);
    console.log(`Step 2: Processed intersections. Result: ${finalEntities.length} segments.`);
};


export const runBeamAttributeMounting = (
    activeProject: ProjectFile,
    projects: ProjectFile[],
    setProjects: React.Dispatch<React.SetStateAction<ProjectFile[]>>,
    setLayerColors: React.Dispatch<React.SetStateAction<Record<string, string>>>
) => {
    // Placeholder for Step 3
    console.log("Step 3: Attribute Mounting (Logic preserved in pipeline structure)");
};

export const runBeamTopologyMerge = (
    activeProject: ProjectFile,
    projects: ProjectFile[],
    setProjects: React.Dispatch<React.SetStateAction<ProjectFile[]>>,
    setLayerColors: React.Dispatch<React.SetStateAction<Record<string, string>>>
) => {
     // Placeholder for Step 4
     console.log("Step 4: Topology Merge");
};

export const runBeamPropagation = (
    activeProject: ProjectFile,
    projects: ProjectFile[],
    setProjects: React.Dispatch<React.SetStateAction<ProjectFile[]>>,
    setLayerColors: React.Dispatch<React.SetStateAction<Record<string, string>>>
) => {
    // Placeholder for Step 5
    console.log("Step 5: Propagation");
};