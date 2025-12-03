
import React from 'react';
import { DxfEntity, EntityType, Point, Bounds, ProjectFile } from '../types';
import { extractEntities } from '../utils/dxfHelpers';
import { updateProject, getMergeBaseBounds, findEntitiesInAllProjects, isEntityInBounds, filterEntitiesInBounds, isPointInBounds, expandBounds, boundsOverlap } from './structure-common';
import {
    getBeamProperties,
    getCenter,
    getEntityBounds,
    distance,
    boundsOverlap as boundsOverlapGeo,
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
    BEAM_STEP2_INTER_SECTION: '#f97316', // Orange-500 for high visibility
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

    // 1. Find Annotation Layers (only merged label layers)
    const beamTextLayers = activeProject.data.layers.filter(l => l === 'MERGE_LABEL_H' || l === 'MERGE_LABEL_V');

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
        const matches = t.text.match(/^.+\s+(\d+)[xX脳]\d+/);
        if (matches) {
            const w = parseInt(matches[1], 10);
            if (!isNaN(w) && w >= 100 && w <= 2000) validWidths.add(w);
        } else {
            const simpleMatch = t.text.match(/^(\d+)[xX脳]\d+$/);
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
        v = { x: -v.x, y: -v.y };
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

    if (Math.abs(dir.x) > 1e-9) {
        const t1 = (bounds.minX - origin.x) / dir.x;
        const t2 = (bounds.maxX - origin.x) / dir.x;
        tmin = Math.max(tmin, Math.min(t1, t2));
        tmax = Math.min(tmax, Math.max(t1, t2));
    } else if (origin.x < bounds.minX || origin.x > bounds.maxX) {
        return { tmin: Infinity, tmax: -Infinity };
    }

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

// Check if a beam is fully "anchored" (both ends touching obstacles)
const isBeamFullyAnchored = (beam: DxfEntity, obstacles: DxfEntity[]): boolean => {
    const obb = computeOBB(beam);
    if (!obb) return false;

    // Check both ends (projected out by a tiny tolerance of 5mm)
    const pFront = { x: obb.center.x + obb.u.x * (obb.maxT + 5), y: obb.center.y + obb.u.y * (obb.maxT + 5) };
    const pBack = { x: obb.center.x + obb.u.x * (obb.minT - 5), y: obb.center.y + obb.u.y * (obb.minT - 5) };

    const isBlocked = (p: Point) => {
        for (const obs of obstacles) {
            const b = getEntityBounds(obs);
            // Use strict bounds for walls/cols
            if (b && isPointInBounds(p, b)) return true;
        }
        return false;
    };

    return isBlocked(pFront) && isBlocked(pBack);
};

// --- MERGE LOGIC (Step 1 & Step 2 Variants) ---

/**
 * Common merge function.
 * @param strictCrossOnly If true, only merges if the gap is crossed by another beam (for Step 2).
 */
const mergeCollinearBeams = (
    polys: DxfEntity[],
    obstacles: DxfEntity[],
    allBeams: DxfEntity[],
    maxGap: number,
    strictCrossOnly: boolean
): DxfEntity[] => {
    const items = polys.map(p => {
        const obb = computeOBB(p);
        return { poly: p, obb };
    }).filter(i => i.obb !== null) as { poly: DxfEntity, obb: OBB }[];

    const obsBounds = obstacles.map(o => getEntityBounds(o)).filter(b => b !== null) as Bounds[];

    // For Step 2 Cross Check: we need OBBs of all potential crossing beams
    const allBeamOBBs = strictCrossOnly ? allBeams.map(b => computeOBB(b)).filter(o => o !== null) as OBB[] : [];

    // Sort
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

    // Helper: Check if gap contains a crossing beam (Step 2 logic)
    const isGapCrossed = (pStart: Point, pEnd: Point, width: number, beamU: Point): boolean => {
        const mid = { x: (pStart.x + pEnd.x) / 2, y: (pStart.y + pEnd.y) / 2 };
        const gapLen = distance(pStart, pEnd);

        // Check against all beams
        for (const other of allBeamOBBs) {
            // 1. Must be perpendicular (Cross)
            const dot = Math.abs(beamU.x * other.u.x + beamU.y * other.u.y);
            if (dot > 0.1) continue; // Skip parallel

            // 2. Must intersect the gap
            // Simple check: is 'mid' inside the 'other' beam's lane?
            // Project mid onto other's V axis
            const vDist = Math.abs((mid.x - other.center.x) * other.v.x + (mid.y - other.center.y) * other.v.y);
            // Project mid onto other's U axis
            const uDist = Math.abs((mid.x - other.center.x) * other.u.x + (mid.y - other.center.y) * other.u.y);

            // Check if within bounds
            if (vDist <= other.halfWidth + 10 &&
                uDist >= other.minT - 10 && uDist <= other.maxT + 10) {
                return true;
            }
        }
        return false;
    };

    const isGapBlockedByObstacle = (pStart: Point, pEnd: Point, width: number): boolean => {
        const minX = Math.min(pStart.x, pEnd.x) - 5;
        const maxX = Math.max(pStart.x, pEnd.x) + 5;
        const minY = Math.min(pStart.y, pEnd.y) - 5;
        const maxY = Math.max(pStart.y, pEnd.y) + 5;

        const gapBounds: Bounds = {
            minX: minX - (width / 2), maxX: maxX + (width / 2),
            minY: minY - (width / 2), maxY: maxY + (width / 2)
        };

        for (const obs of obsBounds) {
            if (boundsOverlapGeo(gapBounds, obs)) return true;
        }
        return false;
    };

    const mergeOBBs = (a: OBB, b: OBB): OBB => {
        const u = a.u;
        const project = (p: Point) => (p.x - a.center.x) * u.x + (p.y - a.center.y) * u.y;

        const minA = a.minT;
        const maxA = a.maxT;
        const centerRel = (b.center.x - a.center.x) * u.x + (b.center.y - a.center.y) * u.y;
        const minB = centerRel + b.minT;
        const maxB = centerRel + b.maxT;

        const newMin = Math.min(minA, minB);
        const newMax = Math.max(maxA, maxB);
        const newLen = newMax - newMin;
        const newCenterU = newMin + newLen / 2;

        const center = {
            x: a.center.x + u.x * newCenterU,
            y: a.center.y + u.y * newCenterU
        };

        const halfWidth = Math.max(a.halfWidth, b.halfWidth);

        return {
            center, u, v: a.v, halfWidth,
            halfLen: newLen / 2, minT: -newLen / 2, maxT: newLen / 2,
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
            for (let j = i + 1; j < items.length; j++) {
                if (used.has(j)) continue;
                const next = items[j].obb;

                // 1. Orientation
                const dot = Math.abs(current.u.x * next.u.x + current.u.y * next.u.y);
                if (dot < 0.98) continue;

                // 2. Lane
                const perpDist = Math.abs((next.center.x - current.center.x) * current.v.x + (next.center.y - current.center.y) * current.v.y);
                if (perpDist > 50) continue;

                // 3. Gap
                const distAlong = (next.center.x - current.center.x) * current.u.x + (next.center.y - current.center.y) * current.u.y;
                const nextStartT = distAlong + next.minT;
                const gap = nextStartT - current.maxT;

                if (gap > maxGap + 10) continue;

                // 4. Width
                if (Math.abs(current.halfWidth - next.halfWidth) * 2 > 100) continue;

                // 5. Gap Logic
                const pEndCurrent = {
                    x: current.center.x + current.u.x * current.maxT,
                    y: current.center.y + current.u.y * current.maxT
                };
                const pStartNext = {
                    x: current.center.x + current.u.x * nextStartT,
                    y: current.center.y + current.u.y * nextStartT
                };

                // A. Check Blockers (Always applies)
                if (isGapBlockedByObstacle(pEndCurrent, pStartNext, current.halfWidth * 2)) continue;

                // B. Check Cross Requirement (Step 2 Only)
                if (strictCrossOnly && gap > 5) { // Tolerance for effectively touching
                    if (!isGapCrossed(pEndCurrent, pStartNext, current.halfWidth * 2, current.u)) {
                        // Gap is empty (no crossing beam), so DON'T merge in Step 2
                        continue;
                    }
                }

                current = mergeOBBs(current, next);
                used.add(j);
                mergedSomething = true;
                break;
            }
        }

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

// 2. Extend Beams (Step 2b) - T-Stem Extension
const extendBeamsToPerpendicular = (
    polys: DxfEntity[],
    targets: DxfEntity[],
    blockers: DxfEntity[],
    maxSearchDist: number,
    viewports: Bounds[]
): DxfEntity[] => {
    const blockerBounds = blockers.map(b => getEntityBounds(b)).filter(b => b !== null) as Bounds[];
    const targetOBBs = targets.map(p => computeOBB(p)).filter(o => o !== null) as OBB[];

    return polys.map(poly => {
        const obb = computeOBB(poly);
        if (!obb) return poly;
        const { center, u, v, halfWidth, minT, maxT } = obb;

        const pFrontLeft = { x: center.x + u.x * maxT + v.x * halfWidth, y: center.y + u.y * maxT + v.y * halfWidth };
        const pFrontRight = { x: center.x + u.x * maxT - v.x * halfWidth, y: center.y + u.y * maxT - v.y * halfWidth };
        const pFrontCenter = { x: center.x + u.x * maxT, y: center.y + u.y * maxT };

        const pBackLeft = { x: center.x + u.x * minT + v.x * halfWidth, y: center.y + u.y * minT + v.y * halfWidth };
        const pBackRight = { x: center.x + u.x * minT - v.x * halfWidth, y: center.y + u.y * minT - v.y * halfWidth };
        const pBackCenter = { x: center.x + u.x * minT, y: center.y + u.y * minT };

        const containingViewport = viewports.find(vp => isPointInBounds(center, vp));

        const getSafeExtension = (origins: Point[], dir: Point): number => {
            let viewportLimit = Infinity;
            if (containingViewport) {
                for (const org of origins) {
                    const { tmax } = rayIntersectsAABB(org, dir, containingViewport);
                    if (tmax > -1e-3) {
                        viewportLimit = Math.min(viewportLimit, Math.max(0, tmax));
                    } else {
                        viewportLimit = 0;
                    }
                }
            }

            let barrierDist = viewportLimit;
            for (const b of blockerBounds) {
                for (const org of origins) {
                    const { tmin, tmax } = rayIntersectsAABB(org, dir, b);
                    if (tmax > -1e-3) {
                        const dist = Math.max(0, tmin);
                        if (dist < barrierDist) barrierDist = dist;
                    }
                }
            }

            if (barrierDist < 10) return 0;

            const searchLimit = Math.min(maxSearchDist, barrierDist);
            let bestExtension = 0;

            for (const t of targetOBBs) {
                if (t.entity === poly) continue;
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
                    const desired = targetHitMax;
                    if (desired <= barrierDist + 10) {
                        if (desired > bestExtension) bestExtension = Math.min(desired, barrierDist);
                    } else {
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

// --- INTERSECTION DETECTION (Topological Arm Counting) ---

const detectIntersections = (beams: DxfEntity[]): { intersections: DxfEntity[], labels: DxfEntity[], info: import('../types').BeamIntersectionInfo[] } => {
    // 1. Compute OBBs
    const obbs = beams.map(b => ({ obb: computeOBB(b), beam: b }));
    const boundsList = beams.map(b => getEntityBounds(b));

    // 2. Cluster Intersections
    // Key: center coordinates (quantized) to merge overlapping intersection zones
    const clusters = new Map<string, { bounds: Bounds, beams: Set<number> }>();

    // Helper to merge bounds
    const mergeBounds = (a: Bounds, b: Bounds): Bounds => ({
        minX: Math.min(a.minX, b.minX),
        minY: Math.min(a.minY, b.minY),
        maxX: Math.max(a.maxX, b.maxX),
        maxY: Math.max(a.maxY, b.maxY)
    });

    const overlapBounds = (a: Bounds, b: Bounds): Bounds | null => {
        const minX = Math.max(a.minX, b.minX);
        const maxX = Math.min(a.maxX, b.maxX);
        const minY = Math.max(a.minY, b.minY);
        const maxY = Math.min(a.maxY, b.maxY);
        if (minX < maxX - 10 && minY < maxY - 10) { // Tolerance 10mm
            return { minX, minY, maxX, maxY };
        }
        return null;
    };

    for (let i = 0; i < obbs.length; i++) {
        const obbA = obbs[i].obb;
        const bA = boundsList[i];
        if (!obbA || !bA) continue;
        const oriA = Math.abs(obbA.u.x) >= Math.abs(obbA.u.y) ? 'H' : 'V';

        for (let j = i + 1; j < obbs.length; j++) {
            const obbB = obbs[j].obb;
            const bB = boundsList[j];
            if (!obbB || !bB) continue;

            const oriB = Math.abs(obbB.u.x) >= Math.abs(obbB.u.y) ? 'H' : 'V';

            // Only consider perpendicular intersections for Cross/T/L
            if (oriA === oriB) continue;

            const overlap = overlapBounds(bA, bB);
            if (!overlap) continue;

            // Found an intersection. Find or create cluster.
            // Simple clustering by center distance
            const cx = (overlap.minX + overlap.maxX) / 2;
            const cy = (overlap.minY + overlap.maxY) / 2;
            const key = `${Math.round(cx / 200)}_${Math.round(cy / 200)}`; // 200mm grid for clustering proximity

            if (!clusters.has(key)) {
                clusters.set(key, { bounds: overlap, beams: new Set([i, j]) });
            } else {
                const c = clusters.get(key)!;
                c.bounds = mergeBounds(c.bounds, overlap);
                c.beams.add(i);
                c.beams.add(j);
            }
        }
    }

    // 3. Classify Shapes
    const intersections: DxfEntity[] = [];
    const labels: DxfEntity[] = [];
    let counter = 1;

    const infos: import('../types').BeamIntersectionInfo[] = [];

    clusters.forEach((val) => {
        // Classify based on topological arms
        const dirs = { right: false, up: false, left: false, down: false };
        const center = { x: (val.bounds.minX + val.bounds.maxX) / 2, y: (val.bounds.minY + val.bounds.maxY) / 2 };
        const tol = 150; // Distance tolerance to consider a beam extending out

        val.beams.forEach(idx => {
            const { obb } = obbs[idx];
            if (!obb) return;
            // Check endpoints of beam
            const p1 = { x: obb.center.x + obb.u.x * obb.maxT, y: obb.center.y + obb.u.y * obb.maxT };
            const p2 = { x: obb.center.x + obb.u.x * obb.minT, y: obb.center.y + obb.u.y * obb.minT };

            // Function to check direction
            const check = (p: Point) => {
                const dx = p.x - center.x;
                const dy = p.y - center.y;
                // If endpoint is within intersection bounds (or close), it does not extend.
                if (Math.abs(dx) < (val.bounds.maxX - val.bounds.minX) / 2 + tol &&
                    Math.abs(dy) < (val.bounds.maxY - val.bounds.minY) / 2 + tol) return;

                if (Math.abs(dx) > Math.abs(dy)) {
                    if (dx > 0) dirs.right = true; else dirs.left = true;
                } else {
                    if (dy > 0) dirs.up = true; else dirs.down = true;
                }
            };
            check(p1);
            check(p2);
        });

        const arms = (dirs.right ? 1 : 0) + (dirs.left ? 1 : 0) + (dirs.up ? 1 : 0) + (dirs.down ? 1 : 0);
        let shape: import('../types').IntersectionShape = 'L';
        if (arms === 4) shape = 'C';
        else if (arms === 3) shape = 'T';

        // Refined visual box (use the computed bounds)
        const rect: DxfEntity = {
            type: EntityType.LWPOLYLINE,
            layer: 'BEAM_STEP2_INTER_SECTION',
            closed: true,
            vertices: [
                { x: val.bounds.minX, y: val.bounds.minY },
                { x: val.bounds.maxX, y: val.bounds.minY },
                { x: val.bounds.maxX, y: val.bounds.maxY },
                { x: val.bounds.minX, y: val.bounds.maxY }
            ]
        };
        intersections.push(rect);

        labels.push({
            type: EntityType.TEXT,
            layer: 'BEAM_STEP2_INTER_SECTION',
            start: center,
            text: `${shape}-${counter++}`,
            radius: 250,
            startAngle: 0
        });

        infos.push({
            id: `INTER-${counter}`,
            layer: 'BEAM_STEP2_INTER_SECTION',
            shape: 'rect',
            vertices: [
                { x: val.bounds.minX, y: val.bounds.minY },
                { x: val.bounds.maxX, y: val.bounds.minY },
                { x: val.bounds.maxX, y: val.bounds.maxY },
                { x: val.bounds.minX, y: val.bounds.maxY }
            ],
            bounds: { startX: val.bounds.minX, startY: val.bounds.minY, endX: val.bounds.maxX, endY: val.bounds.maxY },
            center,
            radius: undefined,
            parts: undefined,
            junction: shape,
            angle: undefined,
            beamIndexes: Array.from(val.beams)
        });
    });

    return { intersections, labels, info: infos };
};

const mergeOverlappingBeams = (beams: DxfEntity[]): DxfEntity[] => {
    const items = beams.map(b => ({ obb: computeOBB(b), beam: b })).filter(i => i.obb !== null) as { obb: OBB, beam: DxfEntity }[];
    const merged: { obb: OBB, beam: DxfEntity }[] = [];
    const used = new Set<number>();

    const mergeOBBs = (a: OBB, b: OBB): OBB => {
        const u = a.u;
        const projCenter = (pt: Point) => (pt.x - a.center.x) * u.x + (pt.y - a.center.y) * u.y;
        const minA = a.minT;
        const maxA = a.maxT;
        const centerRel = projCenter(b.center); // Fixed: was relCenterB
        const minB = centerRel + b.minT;
        const maxB = centerRel + b.maxT;

        const newMin = Math.min(minA, minB);
        const newMax = Math.max(maxA, maxB);
        const newLen = newMax - newMin;
        const newCenterU = newMin + newLen / 2;

        const center = {
            x: a.center.x + u.x * newCenterU,
            y: a.center.y + u.y * newCenterU
        };

        const halfWidth = Math.max(a.halfWidth, b.halfWidth);

        return {
            center, u, v: a.v, halfWidth,
            halfLen: newLen / 2, minT: -newLen / 2, maxT: newLen / 2,
            entity: a.entity
        };
    };

    for (let i = 0; i < items.length; i++) {
        if (used.has(i)) continue;
        let current = items[i].obb;
        let layer = items[i].beam.layer;
        used.add(i);
        let changed = true;
        while (changed) {
            changed = false;
            for (let j = i + 1; j < items.length; j++) {
                if (used.has(j)) continue;
                const other = items[j].obb;
                if (!other) continue;
                const dot = Math.abs(current.u.x * other.u.x + current.u.y * other.u.y);
                if (dot < 0.98) continue;
                const perpDist = Math.abs((other.center.x - current.center.x) * current.v.x + (other.center.y - current.center.y) * current.v.y);
                if (perpDist > Math.max(current.halfWidth, other.halfWidth) + 50) continue;

                const bA = getEntityBounds(current.entity);
                const bB = getEntityBounds(other.entity);
                if (!bA || !bB || !boundsOverlapGeo(bA, bB)) continue;

                current = mergeOBBs(current, other);
                used.add(j);
                changed = true;
            }
        }

        const c = current.center;
        const hw = current.halfWidth;
        const minT = current.minT;
        const maxT = current.maxT;
        const u = current.u;
        const v = current.v;
        const p1 = { x: c.x + u.x * minT + v.x * hw, y: c.y + u.y * minT + v.y * hw };
        const p2 = { x: c.x + u.x * minT - v.x * hw, y: c.y + u.y * minT - v.y * hw };
        const p3 = { x: c.x + u.x * maxT - v.x * hw, y: c.y + u.y * maxT - v.y * hw };
        const p4 = { x: c.x + u.x * maxT + v.x * hw, y: c.y + u.y * maxT + v.y * hw };
        merged.push({ obb: current, beam: { type: EntityType.LWPOLYLINE, layer, closed: true, vertices: [p1, p2, p3, p4] } });
    }

    return merged.map(m => m.beam);
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
    const { lines, obstacles, axisLines, textPool, validWidths } = sources;
    const widthsToUse = validWidths.size > 0 ? validWidths : new Set([200, 250, 300, 350, 400, 500, 600]);
    console.log('Beam availableWidth:', Array.from(widthsToUse).sort((a, b) => a - b));

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

    // Step 1: Strict merge (gap=2mm) for bad CAD splicing
    // Pass 'false' for strictCrossOnly because here we just want to join touching segments.
    const mergedPolys = mergeCollinearBeams(polys, obstacles, [], 2, false);

    updateProject(activeProject, setProjects, setLayerColors, resultLayer, mergedPolys, DEFAULT_BEAM_STAGE_COLORS[resultLayer], ['AXIS'], true);
    console.log(`Step 1: Generated ${mergedPolys.length} raw beam segments.`);
};


export const runBeamIntersectionProcessing = (
    activeProject: ProjectFile,
    projects: ProjectFile[],
    setProjects: React.Dispatch<React.SetStateAction<ProjectFile[]>>,
    setLayerColors: React.Dispatch<React.SetStateAction<Record<string, string>>>
) => {
    // 1. Get Sources
    const sources = collectBeamSources(activeProject, projects);
    if (!sources) return;

    const sourceLayer = 'BEAM_STEP1_RAW';
    const resultLayer = 'BEAM_STEP2_GEO';

    const rawStep1 = activeProject.data.entities.filter(e => e.layer === sourceLayer);
    if (rawStep1.length === 0) {
        alert("Please run Step 1 (Raw Generation) first.");
        return;
    }

    const workingSet = deepCopyEntities(rawStep1);

    const validWidthsArr = Array.from(sources.validWidths);
    console.log('validWidthsArr (parsed from text):', validWidthsArr);
    const maxSearchWidth = validWidthsArr.length > 0 ? Math.max(...validWidthsArr) : 600;
    const strictViewports = activeProject.splitRegions ? activeProject.splitRegions.map(r => r.bounds) : [];

    // --- FILTERING ---
    // Separate beams that are "fully anchored" (both ends blocked) from those needing processing.
    const toProcess: DxfEntity[] = [];
    const completed: DxfEntity[] = [];

    workingSet.forEach(b => {
        if (isBeamFullyAnchored(b, sources.obstacles)) {
            completed.push(b);
        } else {
            toProcess.push(b);
        }
    });

    console.log(`Step 2: Processing ${toProcess.length} segments (${completed.length} skipped as fully anchored).`);

    // Extend beams toward perpendicular targets
    const allTargets = [...toProcess, ...completed];
    const extended = extendBeamsToPerpendicular(toProcess, allTargets, sources.obstacles, maxSearchWidth, strictViewports);

    // Combine
    let finalEntities = [...extended, ...completed].map(e => ({ ...e, layer: resultLayer }));
    if (finalEntities.length === 0) {
        console.log('Step 2: No extended beams; falling back to raw Step1 data.');
        finalEntities = workingSet.map(e => ({ ...e, layer: resultLayer }));
    }
    console.log('Step 2 counts', { toProcess: toProcess.length, completed: completed.length, extended: extended.length, final: finalEntities.length });

    // 6b. Merge overlapping parallel beams
    const mergedBeams = mergeOverlappingBeams(finalEntities);

    // 6c. Add numbering labels to BEAM_STEP2_GEO for visibility
    const labeledEntities: DxfEntity[] = [];
    mergedBeams.forEach((ent, idx) => {
        labeledEntities.push(ent);
        const center = getCenter(ent);
        const obb = computeOBB(ent);
        const angle = obb ? (Math.atan2(obb.u.y, obb.u.x) * 180) / Math.PI : 0;
        if (center) {
            labeledEntities.push({
                type: EntityType.TEXT,
                layer: resultLayer,
                start: center,
                text: `B2-${idx}`,
                radius: 200,
                startAngle: angle
            });
        }
    });

    // 7. Detect and mark intersections
    const interLayer = 'BEAM_STEP2_INTER_SECTION';
    const interMarks = detectIntersections(mergedBeams);

    updateProject(activeProject, setProjects, setLayerColors, resultLayer, labeledEntities, DEFAULT_BEAM_STAGE_COLORS[resultLayer], ['AXIS', 'COLU_CALC', 'WALL_CALC'], true, undefined, [sourceLayer]);
    if (interMarks.intersections.length > 0 || interMarks.labels.length > 0) {
        // Avoid overwriting BEAM_STEP2_GEO by using latest project state in-place
        setLayerColors(prev => ({ ...prev, [interLayer]: DEFAULT_BEAM_STAGE_COLORS[interLayer] }));
        setProjects(prev => prev.map(p => {
            if (p.id !== activeProject.id) return p;
            const newEntities = [...interMarks.intersections, ...interMarks.labels].map(e => ({ ...e, layer: interLayer }));
            const updatedData = {
                ...p.data,
                entities: [...p.data.entities, ...newEntities],
                layers: p.data.layers.includes(interLayer) ? p.data.layers : [interLayer, ...p.data.layers]
            };
            const newActive = new Set(p.activeLayers);
            newActive.add(interLayer);
            ['AXIS', 'COLU_CALC', 'WALL_CALC'].forEach(l => {
                if (updatedData.layers.includes(l)) newActive.add(l);
            });
            return {
                ...p,
                data: updatedData,
                activeLayers: newActive,
                beamStep2InterInfos: interMarks.info
            };
        }));
    }
    // Save step2 GEO result snapshot
    setProjects(prev => prev.map(p => {
        if (p.id !== activeProject.id) return p;
        const geoInfos = mergedBeams.map((ent, idx) => {
            const b = getEntityBounds(ent)!;
            const obb = computeOBB(ent);
            return {
                id: `B2-${idx}`,
                layer: resultLayer,
                shape: 'rect',
                vertices: ent.vertices || [],
                bounds: { startX: b.minX, startY: b.minY, endX: b.maxX, endY: b.maxY },
                center: getCenter(ent) || undefined,
                radius: undefined,
                angle: obb ? (Math.atan2(obb.u.y, obb.u.x) * 180) / Math.PI : undefined,
                beamIndex: idx
            } as import('../types').BeamStep2GeoInfo;
        });
        return { ...p, beamStep2GeoInfos: geoInfos };
    }));
    console.log(`Step 2: Processed intersections. Result: ${finalEntities.length} segments.`);
};


// --- STEP 3: ATTRIBUTE MOUNTING ---
// Extended interface to hold attributes during processing
interface BeamAttributes {
    code: string; // e.g., KL1
    span?: string | null;
    width: number;
    height: number;
    rawLabel: string;
    fromLabel: boolean;
}

export const runBeamAttributeMounting = (
    activeProject: ProjectFile,
    projects: ProjectFile[],
    setProjects: React.Dispatch<React.SetStateAction<ProjectFile[]>>,
    setLayerColors: React.Dispatch<React.SetStateAction<Record<string, string>>>
) => {
    const sourceLayer = 'BEAM_STEP2_GEO';
    const resultLayer = 'BEAM_STEP3_ATTR';
    const debugLayer = 'BEAM_STEP3_TARGET_DEBUG';
    const beamLabels = activeProject.beamLabels || [];
    const sources = collectBeamSources(activeProject, projects);
    if (!sources) return;
    const obstacleBounds = sources.obstacles.map(o => getEntityBounds(o)).filter((b): b is Bounds => !!b);

    const beams = extractEntities([sourceLayer], activeProject.data.entities, activeProject.data.blocks, activeProject.data.blockBasePoints)
        .filter(e => e.type !== EntityType.TEXT);
    if (beams.length === 0) {
        alert("No beams found in Step 2. Run Intersection Processing first.");
        return;
    }

    // 1. Deep Copy Beams to New Layer
    const attrBeams = JSON.parse(JSON.stringify(beams)) as DxfEntity[];
    attrBeams.forEach(b => b.layer = resultLayer);
    const debugMarks: DxfEntity[] = [];

    // 2. Map to OBBs for Hit Testing
    const beamObbs = attrBeams
        .map((b, i) => ({ obb: computeOBB(b), index: i, attr: null as BeamAttributes | null, label: null as DxfEntity | null }))
        .filter(b => b.obb !== null);

    const isPointInOBB = (pt: Point, obb: OBB): boolean => {
        const dx = pt.x - obb.center.x;
        const dy = pt.y - obb.center.y;
        const du = dx * obb.u.x + dy * obb.u.y;
        const dv = dx * -obb.u.y + dy * obb.u.x; // perp
        return Math.abs(du) <= obb.halfLen + 20 && Math.abs(dv) <= obb.halfWidth + 20;
    };

    const findBeamForPoint = (pt: Point | null): typeof beamObbs[number] | null => {
        if (!pt) return null;
        return beamObbs.find(item => {
            const obb = item.obb!;
            return isPointInOBB(pt, obb);
        }) || null;
    };

    const isPointCovered = (pt: Point): boolean => {
        if (beamObbs.some(b => b.obb && isPointInOBB(pt, b.obb))) return true;
        return obstacleBounds.some(b => isPointInBounds(pt, b));
    };

    const geoInfoByIndex = new Map<number, string>();
    (activeProject.beamStep2GeoInfos || []).forEach(info => geoInfoByIndex.set(info.beamIndex, info.id));

    const isConnectedAlongAxis = (a: typeof beamObbs[number], b: typeof beamObbs[number]): boolean => {

        if (!a.obb || !b.obb) return false;
        // Use closest endpoints along axis to test continuity (no empty space between)
        const endA1 = { x: a.obb.center.x + a.obb.u.x * a.obb.maxT, y: a.obb.center.y + a.obb.u.y * a.obb.maxT };
        const endA2 = { x: a.obb.center.x + a.obb.u.x * a.obb.minT, y: a.obb.center.y + a.obb.u.y * a.obb.minT };
        const endB1 = { x: b.obb.center.x + b.obb.u.x * b.obb.maxT, y: b.obb.center.y + b.obb.u.y * b.obb.maxT };
        const endB2 = { x: b.obb.center.x + b.obb.u.x * b.obb.minT, y: b.obb.center.y + b.obb.u.y * b.obb.minT };

        const pair1 = distance(endA1, endB2);
        const pair2 = distance(endA2, endB1);
        const [pA, pB] = pair1 <= pair2 ? [endA1, endB2] : [endA2, endB1];

        const totalDist = distance(pA, pB);
        const steps = Math.max(5, Math.ceil(totalDist / 50));
        const aId = geoInfoByIndex.get(a.index) || `IDX-${a.index}`;
        const bId = geoInfoByIndex.get(b.index) || `IDX-${b.index}`;
        for (let s = 0; s <= steps; s++) {
            const t = s / steps;
            const pt = { x: pA.x + (pB.x - pA.x) * t, y: pA.y + (pB.y - pA.y) * t };
            const covered = isPointCovered(pt);
            if (!covered) {
                return false;
            }
        }
        return true;
    };

    const markDebug = (pt: Point | null, text: string, angle?: number | null) => {
        if (!pt) return;
        debugMarks.push({
            type: EntityType.TEXT,
            layer: debugLayer,
            start: pt,
            text,
            radius: 120,
            startAngle: angle ?? 0
        });
    };

    // 3. Match Logic
    let matchCount = 0;

    beamLabels.forEach(lbl => {
        const leaderAnchor = lbl.leaderStart;
        const leaderArrow = lbl.leaderEnd;

        if (!leaderAnchor || !leaderArrow) return;
        if (distance(leaderAnchor, leaderArrow) < 1e-3) {
            markDebug(leaderAnchor, 'A=B invalid leader');
            return;
        }

        const anchorBeam = findBeamForPoint(leaderAnchor);
        const arrowBeam = findBeamForPoint(leaderArrow);
        const conflict = anchorBeam && arrowBeam && anchorBeam.index !== arrowBeam.index;

        const hitBeam = conflict ? null : (anchorBeam || arrowBeam);

        if (conflict) {
            throw new Error(`Leader endpoints land on different beams in ${resultLayer}. Label: ${lbl.textRaw}`);
        }

        if (hitBeam && lbl.parsed) {
            hitBeam.attr = {
                code: lbl.parsed.code,
                span: lbl.parsed.span,
                width: lbl.parsed.width ?? 0,
                height: lbl.parsed.height ?? 0,
                rawLabel: lbl.textRaw,
                fromLabel: true
            };
            const spanText = lbl.parsed.span ? `(${lbl.parsed.span})` : '';
            markDebug(leaderArrow, `${lbl.parsed.code}${spanText}`, lbl.orientation);
            matchCount++;
        }
    });

    // 5. Propagation (Collinear beams on same axis)
    // Group beams by axis orientation and position (only propagate to beams without attrs and with no large gaps)
    const sortedBeams = [...beamObbs].sort((a, b) => {
        const angA = Math.atan2(a.obb!.u.y, a.obb!.u.x);
        const angB = Math.atan2(b.obb!.u.y, b.obb!.u.x);
        if (Math.abs(angA - angB) > 0.1) return angA - angB;

        // Perpendicular distance from origin
        const distA = a.obb!.center.x * -a.obb!.u.y + a.obb!.center.y * a.obb!.u.x;
        const distB = b.obb!.center.x * -b.obb!.u.y + b.obb!.center.y * b.obb!.u.x;
        return distA - distB;
    });

    // Iterate to find groups
    let i = 0;
    while (i < sortedBeams.length) {
        let j = i + 1;
        const group = [sortedBeams[i]];
        const base = sortedBeams[i];

        while (j < sortedBeams.length) {
            const curr = sortedBeams[j];
            const dot = Math.abs(base.obb!.u.x * curr.obb!.u.x + base.obb!.u.y * curr.obb!.u.y);
            if (dot < 0.98) break; // Angle mismatch

            const perpDistA = base.obb!.center.x * -base.obb!.u.y + base.obb!.center.y * base.obb!.u.x;
            const perpDistB = curr.obb!.center.x * -curr.obb!.u.y + curr.obb!.center.y * curr.obb!.u.x;

            if (Math.abs(perpDistA - perpDistB) > 200) break; // Not collinear

            // Only consider unlabeled beams for propagation; ensure path is covered by beams/obstacles
            const connected = isConnectedAlongAxis(base, curr);
            // if (!connected) break;
            // group.push(curr);
            if (connected) {
                group.push(curr);
            }
            j++;
        }

        // Within this collinear group, check if we have attributes to propagate
        // Strategy: If one beam has attr, spread to others if they don't
        // Refinement: Usually propagation stops at major supports, but here user said "same axis... assign same attributes".
        // We will propagate from the first found attribute to undefined ones.

        // Collect all defined attributes in this line
        const definedAttrs = group.filter(b => b.attr !== null && b.attr.fromLabel).map(b => b.attr!);

        // Simple case: unique attribute for the whole span line
        if (definedAttrs.length > 0) {
            // Use the most frequent or first one? Let's use first for now.
            const primaryAttr = definedAttrs[0];

            group.forEach(b => {
                if (!b.attr) {
                    b.attr = { ...primaryAttr, fromLabel: false }; // Copy only to unlabeled
                }
            });
        }

        i++;
    }

    const unlabeledBeams = beamObbs.filter(b => !b.attr);
    if (unlabeledBeams.length > 0) {
        console.warn('Beams without labels/propagation:', unlabeledBeams.map(b => ({
            index: b.index,
            center: b.obb?.center,
            angle: b.obb ? (Math.atan2(b.obb.u.y, b.obb.u.x) * 180) / Math.PI : null,
            bounds: b.obb ? { minT: b.obb.minT, maxT: b.obb.maxT, halfWidth: b.obb.halfWidth } : null
        })));
    }

    // 6. Generate Text Entities by reusing original labels (append code on new line)
    const updatedLabels: DxfEntity[] = [];
    beamObbs.forEach((b, idx) => {
        if (!b.attr || !b.obb) return;
        const angleDeg = Math.atan2(b.obb!.u.y, b.obb!.u.x) * 180 / Math.PI;
        let finalAngle = angleDeg;
        if (finalAngle > 90 || finalAngle < -90) finalAngle += 180;
        if (finalAngle > 180) finalAngle -= 360;
        const spanText = b.attr.span ? `(${b.attr.span})` : '';
        const geoId = geoInfoByIndex.get(idx) || `B2-${idx}`;

        updatedLabels.push({
            type: EntityType.TEXT,
            layer: resultLayer,
            text: `${geoId}\n${b.attr.code}${spanText}`,
            start: b.obb!.center,
            radius: 160,
            startAngle: finalAngle
        });
    });

    // 7. Commit
    updateProject(
        activeProject,
        setProjects,
        setLayerColors,
        resultLayer,
        [...attrBeams, ...updatedLabels, ...debugMarks],
        '#8b5cf6', // Violet
        ['AXIS', 'COLU_CALC'],
        true,
        undefined,
        ['BEAM_STEP1_RAW', 'BEAM_STEP2_GEO', 'BEAM_STEP2_INTER_SECTION'] // Hide previous markers to clean up view
    );

    if (debugMarks.length > 0) {
        setLayerColors(prev => ({ ...prev, [debugLayer]: '#ff0000' }));
        setProjects(prev => prev.map(p => {
            if (p.id !== activeProject.id) return p;
            const layers = p.data.layers.includes(debugLayer) ? p.data.layers : [debugLayer, ...p.data.layers];
            const activeLayers = new Set(p.activeLayers);
            activeLayers.add(debugLayer);
            return {
                ...p,
                data: { ...p.data, layers },
                activeLayers
            };
        }));
    }

    // Save step3 ATTR result snapshot
    setProjects(prev => prev.map(p => {
        if (p.id !== activeProject.id) return p;
        const infos: import('../types').BeamStep3AttrInfo[] = beamObbs.map((b, idx) => {
            const ent = attrBeams[idx];
            const bounds = getEntityBounds(ent);
            const spanText = b.attr?.span;
            const angle = b.obb ? (Math.atan2(b.obb.u.y, b.obb.u.x) * 180) / Math.PI : undefined;
            return {
                id: `B3-${idx}`,
                layer: resultLayer,
                shape: 'rect',
                vertices: ent.vertices || [],
                bounds: bounds ? { startX: bounds.minX, startY: bounds.minY, endX: bounds.maxX, endY: bounds.maxY } : { startX: 0, startY: 0, endX: 0, endY: 0 },
                center: getCenter(ent) || undefined,
                radius: undefined,
                angle,
                beamIndex: idx,
                code: b.attr?.code || '',
                span: spanText,
                width: b.attr?.width,
                height: b.attr?.height,
                rawLabel: b.attr?.rawLabel || ''
            };
        });
        return { ...p, beamStep3AttrInfos: infos };
    }));

    console.log(`Matched ${matchCount} labels. Propagated to full axes.`);
};

// --- STEP 4: TOPOLOGY MERGE ---
// Logic: Resolve intersections by trimming Secondary beams and keeping Main beams.
// Rules: 
// 1. Width (Wider = Main)
// 2. Height (Higher = Main)
// 3. Code (WKL > KL > LL > XL > L)
// 4. Length (Longer = Main)

export const runBeamTopologyMerge = (
    activeProject: ProjectFile,
    projects: ProjectFile[],
    setProjects: React.Dispatch<React.SetStateAction<ProjectFile[]>>,
    setLayerColors: React.Dispatch<React.SetStateAction<Record<string, string>>>
) => {
    const prevLayer = 'BEAM_STEP3_ATTR';
    const resultLayer = 'BEAM_STEP4_LOGIC';
    
    // 1. Load Data
    const infos = activeProject.beamStep3AttrInfos;
    const intersections = activeProject.beamStep2InterInfos;
    
    if (!infos || infos.length === 0 || !intersections || intersections.length === 0) {
        alert("Missing Step 3 attributes or Step 2 intersections. Please run previous steps.");
        return;
    }

    // Working Set: Map beamIndex to a mutable structure tracking cuts
    // cuts: list of [tMin, tMax] intervals to remove relative to beam's center along U-axis
    const beamCuts = new Map<number, Array<{min: number, max: number}>>();
    
    // Helper to get beam priority score
    const getCodePriority = (code: string | undefined): number => {
        if (!code) return 0;
        const c = code.toUpperCase();
        if (c.startsWith('WKL')) return 5;
        if (c.startsWith('KL')) return 4;
        if (c.startsWith('LL')) return 3;
        if (c.startsWith('XL')) return 2;
        if (c.startsWith('L')) return 1;
        return 0;
    };

    const getBeamLen = (info: import('../types').BeamStep3AttrInfo): number => {
         // reconstruct OBB length approx
         // Since we don't have OBB directly stored in info, we recompute from vertices
         const poly: DxfEntity = { type: EntityType.LWPOLYLINE, vertices: info.vertices, closed: true, layer: 'TEMP' };
         const obb = computeOBB(poly);
         return obb ? obb.halfLen * 2 : 0;
    };

    // 2. Iterate Intersections
    intersections.forEach(inter => {
        const involvedIndices = inter.beamIndexes;
        if (involvedIndices.length < 2) return;

        // Fetch beam objects
        const beams = involvedIndices.map(idx => {
            const info = infos.find(i => i.beamIndex === idx);
            return info ? { idx, info, priority: getCodePriority(info.code), len: getBeamLen(info) } : null;
        }).filter(b => b !== null) as { idx: number, info: import('../types').BeamStep3AttrInfo, priority: number, len: number }[];

        if (beams.length < 2) return;

        // Sort by Rules: Width > Height > Code > Length
        beams.sort((a, b) => {
             const wA = a.info.width || 0;
             const wB = b.info.width || 0;
             if (Math.abs(wA - wB) > 10) return wB - wA; // Wider first

             const hA = a.info.height || 0;
             const hB = b.info.height || 0;
             if (Math.abs(hA - hB) > 10) return hB - hA; // Higher first

             if (a.priority !== b.priority) return b.priority - a.priority; // Better code first

             return b.len - a.len; // Longer first
        });

        // Winner is Main, others are Secondary
        const main = beams[0];
        const secondaries = beams.slice(1);

        // Apply Cuts to Secondaries
        // Cut zone is the intersection rectangle projected onto the secondary beam
        // Intersection Bounds:
        const iBounds = inter.bounds;
        const iPolyPoints = [
            { x: iBounds.startX, y: iBounds.startY },
            { x: iBounds.endX, y: iBounds.startY },
            { x: iBounds.endX, y: iBounds.endY },
            { x: iBounds.startX, y: iBounds.endY }
        ];

        secondaries.forEach(sec => {
            const poly: DxfEntity = { type: EntityType.LWPOLYLINE, vertices: sec.info.vertices, closed: true, layer: 'TEMP' };
            const obb = computeOBB(poly);
            if (!obb) return;

            // Project intersection vertices onto beam's U axis relative to center
            let minP = Infinity;
            let maxP = -Infinity;

            const project = (p: Point) => (p.x - obb.center.x) * obb.u.x + (p.y - obb.center.y) * obb.u.y;

            iPolyPoints.forEach(p => {
                 const t = project(p);
                 minP = Math.min(minP, t);
                 maxP = Math.max(maxP, t);
            });

            // Clamp cut to beam length? Not strictly necessary if we use interval math, 
            // but good for sanity.
            // Beam valid range is [obb.minT, obb.maxT]
            // We want to remove [minP, maxP]
            
            if (!beamCuts.has(sec.idx)) beamCuts.set(sec.idx, []);
            beamCuts.get(sec.idx)!.push({ min: minP, max: maxP });
        });
    });

    // 3. Reconstruct Beams
    const finalEntities: DxfEntity[] = [];
    const finalLabels: DxfEntity[] = [];

    infos.forEach(info => {
        const poly: DxfEntity = { type: EntityType.LWPOLYLINE, vertices: info.vertices, closed: true, layer: 'TEMP' };
        const obb = computeOBB(poly);
        if (!obb) return;

        const cuts = beamCuts.get(info.beamIndex);
        
        // Original Segment Range
        let segments = [{ start: obb.minT, end: obb.maxT }];

        if (cuts && cuts.length > 0) {
            // Merge cuts
            cuts.sort((a, b) => a.min - b.min);
            const mergedCuts: {min: number, max: number}[] = [];
            if (cuts.length > 0) {
                let curr = cuts[0];
                for(let i=1; i<cuts.length; i++) {
                    if (cuts[i].min < curr.max) {
                        curr.max = Math.max(curr.max, cuts[i].max);
                    } else {
                        mergedCuts.push(curr);
                        curr = cuts[i];
                    }
                }
                mergedCuts.push(curr);
            }

            // Subtract cuts from segments
            for (const cut of mergedCuts) {
                const nextSegments: {start: number, end: number}[] = [];
                for (const seg of segments) {
                    // Case 1: Cut strictly inside segment -> split
                    if (cut.min > seg.start && cut.max < seg.end) {
                        nextSegments.push({ start: seg.start, end: cut.min });
                        nextSegments.push({ start: cut.max, end: seg.end });
                    }
                    // Case 2: Cut covers start -> trim start
                    else if (cut.min <= seg.start && cut.max > seg.start && cut.max < seg.end) {
                         nextSegments.push({ start: cut.max, end: seg.end });
                    }
                    // Case 3: Cut covers end -> trim end
                    else if (cut.min > seg.start && cut.min < seg.end && cut.max >= seg.end) {
                        nextSegments.push({ start: seg.start, end: cut.min });
                    }
                    // Case 4: Cut covers whole segment -> remove
                    else if (cut.min <= seg.start && cut.max >= seg.end) {
                        // Drop
                    }
                    // Case 5: No overlap -> keep
                    else {
                        nextSegments.push(seg);
                    }
                }
                segments = nextSegments;
            }
        }

        // Create Polygons for segments
        const { center, u, v, halfWidth } = obb;

        segments.forEach(seg => {
            if (seg.end - seg.start < 10) return; // Skip tiny fragments

            const p1 = { x: center.x + u.x * seg.start + v.x * halfWidth, y: center.y + u.y * seg.start + v.y * halfWidth };
            const p2 = { x: center.x + u.x * seg.start - v.x * halfWidth, y: center.y + u.y * seg.start - v.y * halfWidth };
            const p3 = { x: center.x + u.x * seg.end - v.x * halfWidth, y: center.y + u.y * seg.end - v.y * halfWidth };
            const p4 = { x: center.x + u.x * seg.end + v.x * halfWidth, y: center.y + u.y * seg.end + v.y * halfWidth };

            finalEntities.push({
                type: EntityType.LWPOLYLINE,
                layer: resultLayer,
                closed: true,
                vertices: [p1, p2, p3, p4]
            });
            
            // Add Label if fragment is long enough
            if (seg.end - seg.start > 500) {
                 const midT = (seg.start + seg.end) / 2;
                 const midPt = { x: center.x + u.x * midT, y: center.y + u.y * midT };
                 const angleDeg = Math.atan2(u.y, u.x) * 180 / Math.PI;
                 let finalAngle = angleDeg;
                 if (finalAngle > 90 || finalAngle < -90) finalAngle += 180;
                 if (finalAngle > 180) finalAngle -= 360;

                 const spanText = info.span ? `(${info.span})` : '';
                 finalLabels.push({
                    type: EntityType.TEXT,
                    layer: resultLayer,
                    text: `${info.code}${spanText}`,
                    start: midPt,
                    radius: 160,
                    startAngle: finalAngle
                 });
            }
        });
    });
    
    // 4. Update Project
    updateProject(
        activeProject,
        setProjects,
        setLayerColors,
        resultLayer,
        [...finalEntities, ...finalLabels],
        '#ec4899', // Pink (reusing step 5 color or unique)
        ['AXIS', 'COLU_CALC', 'WALL_CALC'],
        true,
        undefined,
        [prevLayer, 'BEAM_STEP2_INTER_SECTION'] 
    );
    
    console.log(`Step 4: Topology Merge Complete. Generated ${finalEntities.length} fragments.`);
};

export const runBeamPropagation = (
    activeProject: ProjectFile,
    projects: ProjectFile[],
    setProjects: React.Dispatch<React.SetStateAction<ProjectFile[]>>,
    setLayerColors: React.Dispatch<React.SetStateAction<Record<string, string>>>
) => {
    console.log("Step 5: Propagation");
};
