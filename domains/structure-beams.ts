import React from 'react';
import { DxfEntity, EntityType, Point, Bounds, ProjectFile } from '../types';
import { extractEntities } from '../utils/dxfHelpers';
import { updateProject, getMergeBaseBounds, findEntitiesInAllProjects, isEntityInBounds, filterEntitiesInBounds, isPointInBounds, expandBounds, boundsOverlap } from './structure-common';
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
    BEAM_STEP2_INTER_SECTION: '#0ea5e9', // Light blue for cross intersections
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
            if (boundsOverlap(gapBounds, obs)) return true;
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

/**
 * Common merge function.
 * @param strictCrossOnly If true, only merges if the gap is crossed by another beam (for Step 2).
 */
type IntersectionShape = 'CROSS' | 'T' | 'L';

const mergeCrossBeams = (
    polys: DxfEntity[],
    obstacles: DxfEntity[],
    allBeams: DxfEntity[],
    validWidths: Set<number>
): { beams: DxfEntity[], intersections: DxfEntity[], labels: DxfEntity[] } => {
    const items = polys.map((p, idx) => {
        const obb = computeOBB(p);
        return { poly: p, obb, idx };
    }).filter(i => i.obb !== null) as { poly: DxfEntity, obb: OBB, idx: number }[];
    console.log('mergeCrossBeams init', { polys: polys.length, items: items.length });

    const obsBounds = obstacles.map(o => getEntityBounds(o)).filter(b => b !== null) as Bounds[];
    const beamBounds = allBeams
        .map((b, idx) => ({ idx, bounds: getEntityBounds(b) }))
        .filter(b => b.bounds !== null) as { idx: number, bounds: Bounds }[];
    console.log('mergeCrossBeams bounds', { obsBounds: obsBounds.length, beamBounds: beamBounds.length, validWidths: Array.from(validWidths) });

    const blockHitSamples: any[] = [];
    const isBlocked = (pt: Point, selfIdx?: number, includeBeams: boolean = false): boolean => {
        for (const [idx, b] of obsBounds.entries()) {
            if (pt.x >= b.minX - 5 && pt.x <= b.maxX + 5 && pt.y >= b.minY - 5 && pt.y <= b.maxY + 5) {
                if (blockHitSamples.length < 10) blockHitSamples.push({ type: 'obstacle', idx, pt });
                return true;
            }
        }
        if (!includeBeams) return false;
        for (const bb of beamBounds) {
            if (selfIdx !== undefined && bb.idx === selfIdx) continue;
            const b = bb.bounds;
            if (pt.x >= b.minX - 5 && pt.x <= b.maxX + 5 && pt.y >= b.minY - 5 && pt.y <= b.maxY + 5) {
                if (blockHitSamples.length < 10) blockHitSamples.push({ type: 'beam', hit: bb.idx, self: selfIdx ?? null, pt });
                return true;
            }
        }
        return false;
    };

    const canTravel = (start: Point, dir: Point, dist: number, ignore: Set<number>): boolean => {
        for (const b of obsBounds) {
            const { tmin, tmax } = rayIntersectsAABB(start, dir, b);
            if (tmax > -1e-6 && tmin < dist + 1e-3) return false;
        }
        for (const bb of beamBounds) {
            if (ignore.has(bb.idx)) continue;
            const b = bb.bounds;
            const { tmin, tmax } = rayIntersectsAABB(start, dir, b);
            if (tmax > -1e-6 && tmin < dist + 1e-3) return false;
        }
        return true;
    };

    const chooseWidth = (gap: number, preferred: number | null): number | null => {
        if (preferred !== null && preferred >= gap - 1e-3) return preferred;
        return null;
    };

    const makeRect = (center: Point, u: Point, v: Point, halfU: number, halfV: number, layer: string): DxfEntity => {
        const p1 = { x: center.x + u.x * halfU + v.x * halfV, y: center.y + u.y * halfU + v.y * halfV };
        const p2 = { x: center.x - u.x * halfU + v.x * halfV, y: center.y - u.y * halfU + v.y * halfV };
        const p3 = { x: center.x - u.x * halfU - v.x * halfV, y: center.y - u.y * halfU - v.y * halfV };
        const p4 = { x: center.x + u.x * halfU - v.x * halfV, y: center.y + u.y * halfU - v.y * halfV };
        return { type: EntityType.LWPOLYLINE, layer, closed: true, vertices: [p1, p2, p3, p4] };
    };

    const extensions = new Map<number, { minT: number, maxT: number }>();
    const intersections: DxfEntity[] = [];
    const labels: DxfEntity[] = [];
    const seen = new Set<string>();
    const pairStats = {
        pairsChecked: 0,
        skipNoDir: 0,
        skipNoWidth: 0,
        skipGapTooBig: 0,
        skipTravelH: 0,
        skipTravelV: 0,
        added: 0
    };

    const endBlocks = new Map<number, { front: boolean, back: boolean }>();
    let blockedBoth = 0;
    let blockedFrontOnly = 0;
    let blockedBackOnly = 0;
    let freeBoth = 0;
    items.forEach(info => {
        const { center, u, minT, maxT } = info.obb;
        const front = { x: center.x + u.x * maxT, y: center.y + u.y * maxT };
        const back = { x: center.x + u.x * minT, y: center.y + u.y * minT };
        // Only treat walls/columns as blockers for end-free check; beams are ignored here to allow crossings
        const frontBlocked = isBlocked(front, info.idx, false);
        const backBlocked = isBlocked(back, info.idx, false);
        if (items.length <= 10) {
            console.log('endBlocks detail', { idx: info.idx, front, back, frontBlocked, backBlocked, minT, maxT, center });
        }
        if (frontBlocked && backBlocked) blockedBoth++;
        else if (frontBlocked) blockedFrontOnly++;
        else if (backBlocked) blockedBackOnly++;
        else freeBoth++;
        endBlocks.set(info.idx, { front: frontBlocked, back: backBlocked });
    });

    // Allow beams with at least one free end; fully anchored beams stay out
    const extendable = items.filter(info => {
        const ends = endBlocks.get(info.idx);
        return ends ? !(ends.front && ends.back) : true;
    });

    const horizontal = extendable.filter(c => Math.abs(c.obb.u.x) >= Math.abs(c.obb.u.y));
    const vertical = extendable.filter(c => Math.abs(c.obb.u.x) < Math.abs(c.obb.u.y));
    console.log('mergeCrossBeams stats', {
        total: items.length,
        obstacles: obsBounds.length,
        beamBounds: beamBounds.length,
        extendable: extendable.length,
        horizontal: horizontal.length,
        vertical: vertical.length,
        blockedBoth,
        blockedFrontOnly,
        blockedBackOnly,
        freeBoth,
        sampleEnds: endBlocks,
        blockHitSamples
    });

    horizontal.forEach(h => {
        vertical.forEach(v => {
            pairStats.pairsChecked++;
            const inter: Point = { x: v.obb.center.x, y: h.obb.center.y };
            const projH = (inter.x - h.obb.center.x) * h.obb.u.x + (inter.y - h.obb.center.y) * h.obb.u.y;
            const projV = (inter.x - v.obb.center.x) * v.obb.u.x + (inter.y - v.obb.center.y) * v.obb.u.y;

            let gapH = 0;
            let dirH: Point | null = null;
            const hEnds = endBlocks.get(h.idx);
            if (projH > h.obb.maxT) {
                if (!hEnds?.front) { gapH = projH - h.obb.maxT; dirH = h.obb.u; }
            } else if (projH < h.obb.minT) {
                if (!hEnds?.back) { gapH = h.obb.minT - projH; dirH = { x: -h.obb.u.x, y: -h.obb.u.y }; }
            }

            let gapV = 0;
            let dirV: Point | null = null;
            const vEnds = endBlocks.get(v.idx);
            if (projV > v.obb.maxT) {
                if (!vEnds?.front) { gapV = projV - v.obb.maxT; dirV = v.obb.u; }
            } else if (projV < v.obb.minT) {
                if (!vEnds?.back) { gapV = v.obb.minT - projV; dirV = { x: -v.obb.u.x, y: -v.obb.u.y }; }
            }

            const widthH = h.obb.halfWidth * 2;
            const widthV = v.obb.halfWidth * 2;
            const limitH = chooseWidth(gapH, widthV || null);
            const limitV = chooseWidth(gapV, widthH || null);

            if ((!dirH && !dirV)) { pairStats.skipNoDir++; console.log('gapH/gapV2', { reason: 'noDir', hId: h.idx, vId: v.idx, gapH, gapV }); return; }
            if (limitH === null || limitV === null) { pairStats.skipNoWidth++; console.log('gapH/gapV2', { reason: 'noWidth', hId: h.idx, vId: v.idx, gapH, gapV, widthH, widthV }); return; }
            if (gapH > limitH + 1e-3 || gapV > limitV + 1e-3) { pairStats.skipGapTooBig++; console.log('gapH/gapV2', { reason: 'gapTooBig', hId: h.idx, vId: v.idx, gapH, gapV, limitH, limitV }); return; }

            if (dirH) {
                const startH = { x: h.obb.center.x + h.obb.u.x * (projH > h.obb.maxT ? h.obb.maxT : h.obb.minT), y: h.obb.center.y + h.obb.u.y * (projH > h.obb.maxT ? h.obb.maxT : h.obb.minT) };
                if (!canTravel(startH, dirH, gapH, new Set([h.idx, v.idx]))) { pairStats.skipTravelH++; return; }
            }
            if (dirV) {
                const startV = { x: v.obb.center.x + v.obb.u.x * (projV > v.obb.maxT ? v.obb.maxT : v.obb.minT), y: v.obb.center.y + v.obb.u.y * (projV > v.obb.maxT ? v.obb.maxT : v.obb.minT) };
                if (!canTravel(startV, dirV, gapV, new Set([h.idx, v.idx]))) { pairStats.skipTravelV++; return; }
            }

            const pushRange = (id: number, t: number) => {
                const ex = extensions.get(id);
                if (!ex) extensions.set(id, { minT: t, maxT: t });
                else {
                    ex.minT = Math.min(ex.minT, t);
                    ex.maxT = Math.max(ex.maxT, t);
                }
            };
            pushRange(h.idx, projH);
            pushRange(v.idx, projV);

            const key = `${Math.round(inter.x)}-${Math.round(inter.y)}-${Math.round(widthH)}-${Math.round(widthV)}`;
            if (!seen.has(key)) {
                seen.add(key);
                const shape: IntersectionShape =
                    gapH > 0 && gapV > 0 ? 'CROSS' :
                        (gapH === 0 && gapV === 0 ? 'CROSS' : 'T');

                const rect = makeRect(inter, h.obb.u, v.obb.u, widthH / 2, widthV / 2, 'BEAM_STEP2_INTER_SECTION');
                intersections.push(rect);
                pairStats.added++;
                labels.push({
                    type: EntityType.TEXT,
                    layer: 'BEAM_STEP2_INTER_SECTION',
                    start: inter,
                    text: shape,
                    radius: Math.max(widthH, widthV) * 0.6,
                    startAngle: 0
                });
            }
        });
    });

    const beams: DxfEntity[] = items.map(item => {
        const ext = extensions.get(item.idx);
        const minT = ext ? Math.min(item.obb.minT, ext.minT) : item.obb.minT;
        const maxT = ext ? Math.max(item.obb.maxT, ext.maxT) : item.obb.maxT;
        const newCenter = { x: item.obb.center.x + item.obb.u.x * ((minT + maxT) / 2), y: item.obb.center.y + item.obb.u.y * ((minT + maxT) / 2) };
        return makeRect(newCenter, item.obb.u, item.obb.v, (maxT - minT) / 2, item.obb.halfWidth, item.poly.layer);
    });

    console.log('mergeCrossBeams pairStats', pairStats);

    return { beams, intersections, labels };
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

// --- SIMPLE INTERSECTION DETECTION ---

const getOrientationSimple = (obb: OBB): 'H' | 'V' => {
    return Math.abs(obb.u.x) >= Math.abs(obb.u.y) ? 'H' : 'V';
};

const detectIntersections = (beams: DxfEntity[]): { intersections: DxfEntity[], labels: DxfEntity[] } => {
    const obbs = beams.map(b => ({ obb: computeOBB(b), beam: b }));
    const boundsList = beams.map(b => getEntityBounds(b));
    const clusters = new Map<string, { bounds: Bounds, beams: Set<number>, shapes: IntersectionShape[] }>();
    let counter = 1;

    const overlapBounds = (a: Bounds, b: Bounds): Bounds | null => {
        const minX = Math.max(a.minX, b.minX);
        const maxX = Math.min(a.maxX, b.maxX);
        const minY = Math.max(a.minY, b.minY);
        const maxY = Math.min(a.maxY, b.maxY);
        if (minX < maxX && minY < maxY) {
            const area = (maxX - minX) * (maxY - minY);
            if (area < 50) return null; // filter tiny overlaps
            return { minX, minY, maxX, maxY };
        }
        return null;
    };

    const classify = (obbA: OBB, obbB: OBB, center: Point): IntersectionShape => {
        const oriA = getOrientationSimple(obbA);
        const oriB = getOrientationSimple(obbB);
        if (oriA === oriB) return 'T';
        const project = (obb: OBB, c: Point) => {
            const t = (c.x - obb.center.x) * obb.u.x + (c.y - obb.center.y) * obb.u.y;
            const atEnd = Math.min(Math.abs(t - obb.minT), Math.abs(t - obb.maxT)) < obb.halfWidth * 0.8;
            return { atEnd };
        };
        const pa = project(obbA, center);
        const pb = project(obbB, center);
        if (pa.atEnd && pb.atEnd) return 'L';
        if (pa.atEnd || pb.atEnd) return 'T';
        return 'CROSS';
    };

    for (let i = 0; i < obbs.length; i++) {
        const obbA = obbs[i].obb;
        const bA = boundsList[i];
        if (!obbA || !bA) continue;
        for (let j = i + 1; j < obbs.length; j++) {
            const obbB = obbs[j].obb;
            const bB = boundsList[j];
            if (!obbB || !bB) continue;
            // only consider perpendicular overlaps for intersection marking
            const oriA = getOrientationSimple(obbA);
            const oriB = getOrientationSimple(obbB);
            if (oriA === oriB) continue;
            const overlap = overlapBounds(bA, bB);
            if (!overlap) continue;
            const center = { x: (overlap.minX + overlap.maxX) / 2, y: (overlap.minY + overlap.maxY) / 2 };
            const shape = classify(obbA, obbB, center);
            const key = `${Math.round(center.x)}-${Math.round(center.y)}`;
            if (!clusters.has(key)) {
                clusters.set(key, { bounds: overlap, beams: new Set<number>([i, j]), shapes: [shape] });
            } else {
                const c = clusters.get(key)!;
                c.beams.add(i); c.beams.add(j);
                c.shapes.push(shape);
                c.bounds = {
                    minX: Math.min(c.bounds.minX, overlap.minX),
                    minY: Math.min(c.bounds.minY, overlap.minY),
                    maxX: Math.max(c.bounds.maxX, overlap.maxX),
                    maxY: Math.max(c.bounds.maxY, overlap.maxY)
                };
            }
        }
    }

    const intersections: DxfEntity[] = [];
    const labels: DxfEntity[] = [];

    clusters.forEach((val) => {
        const oriCounts = { H: 0, V: 0 };
        val.beams.forEach(idx => {
            const obb = obbs[idx].obb;
            if (!obb) return;
            const ori = getOrientationSimple(obb);
            if (ori === 'H') oriCounts.H++; else oriCounts.V++;
        });
        let shape: IntersectionShape = 'T';
        if (oriCounts.H >= 1 && oriCounts.V >= 1 && val.beams.size >= 4) {
            shape = 'CROSS';
        } else {
            // fallback to most severe shape in this cluster
            shape = val.shapes.includes('CROSS') ? 'CROSS' : (val.shapes.includes('T') ? 'T' : 'L');
        }
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
        const center = { x: (val.bounds.minX + val.bounds.maxX) / 2, y: (val.bounds.minY + val.bounds.maxY) / 2 };
        labels.push({
            type: EntityType.TEXT,
            layer: 'BEAM_STEP2_INTER_SECTION',
            start: center,
            text: `${shape[0]}-${counter}`,
            radius: 240,
            startAngle: 0
        });
        counter++;
    });

    return { intersections, labels };
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
        const relCenterB = projCenter(b.center);
        const minB = relCenterB + b.minT;
        const maxB = relCenterB + b.maxT;
        const newMin = Math.min(minA, minB);
        const newMax = Math.max(maxA, maxB);
        const newLen = newMax - newMin;
        const center = {
            x: a.center.x + u.x * (newMin + newLen / 2),
            y: a.center.y + u.y * (newMin + newLen / 2)
        };
        const halfWidth = Math.max(a.halfWidth, b.halfWidth);
        return {
            center,
            u,
            v: a.v,
            halfWidth,
            halfLen: newLen / 2,
            minT: -newLen / 2,
            maxT: newLen / 2,
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
                if (!bA || !bB || !boundsOverlap(bA, bB)) continue;

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
                text: `B2-${idx + 1}`,
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
                activeLayers: newActive
            };
        }));
    }
    console.log(`Step 2: Processed intersections. Result: ${finalEntities.length} segments.`);
};


export const runBeamAttributeMounting = (
    activeProject: ProjectFile,
    projects: ProjectFile[],
    setProjects: React.Dispatch<React.SetStateAction<ProjectFile[]>>,
    setLayerColors: React.Dispatch<React.SetStateAction<Record<string, string>>>
) => {
    console.log("Step 3: Attribute Mounting");
};

export const runBeamTopologyMerge = (
    activeProject: ProjectFile,
    projects: ProjectFile[],
    setProjects: React.Dispatch<React.SetStateAction<ProjectFile[]>>,
    setLayerColors: React.Dispatch<React.SetStateAction<Record<string, string>>>
) => {
    console.log("Step 4: Topology Merge");
};

export const runBeamPropagation = (
    activeProject: ProjectFile,
    projects: ProjectFile[],
    setProjects: React.Dispatch<React.SetStateAction<ProjectFile[]>>,
    setLayerColors: React.Dispatch<React.SetStateAction<Record<string, string>>>
) => {
    console.log("Step 5: Propagation");
};
