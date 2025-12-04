
import { DxfEntity, EntityType, Point, Bounds, ProjectFile, SemanticLayer, BeamIntersectionInfo, IntersectionShape } from '../../../types';
import { extractEntities } from '../../../utils/dxfHelpers';
import { getMergeBaseBounds, filterEntitiesInBounds, isPointInBounds } from '../common';
import {
    getCenter,
    getEntityBounds,
    distance,
    boundsOverlap as boundsOverlapGeo
} from '../../../utils/geometryUtils';

// --- TYPES & CONSTANTS ---

export type BeamTypeTag = 'MAIN' | 'SECONDARY' | 'UNKNOWN';

export interface BeamSegment extends DxfEntity {
    __beamId: string;
    beamType?: BeamTypeTag;
    beamLabel?: string | null;
    beamAngle?: number;
}

export const DEFAULT_BEAM_STAGE_COLORS: Record<string, string> = {
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
export const deepCopyEntities = (entities: DxfEntity[]): DxfEntity[] => {
    return JSON.parse(JSON.stringify(entities));
};

export const collectBeamSources = (
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

    const beamLayers = activeProject.layerConfig[SemanticLayer.BEAM];
    if (beamLayers.length === 0) {
        alert("No Beam layers configured.");
        return null;
    }

    let rawEntities = extractEntities(beamLayers, activeProject.data.entities, activeProject.data.blocks, activeProject.data.blockBasePoints);
    let rawTextEntities = extractEntities(beamTextLayers, activeProject.data.entities, activeProject.data.blocks, activeProject.data.blockBasePoints)
        .filter(e => e.type === EntityType.TEXT && !e.layer.toUpperCase().startsWith('Z_'));

    const entities = filterEntitiesInBounds(rawEntities, baseBounds);
    const textEntities = filterEntitiesInBounds(rawTextEntities, baseBounds);

    // Axis Lines
    const axisLayers = activeProject.layerConfig[SemanticLayer.AXIS];
    const rawAxis = extractEntities(axisLayers, activeProject.data.entities, activeProject.data.blocks, activeProject.data.blockBasePoints);
    const axisLines = filterEntitiesInBounds(rawAxis, baseBounds);

    // 2. Obstacles (Walls and Columns)
    // Always include calculated results if present
    let walls: DxfEntity[] = [];
    const wallCalcLayer = activeProject.data.layers.find(l => l === 'WALL_CALC');
    if (wallCalcLayer) {
        walls = extractEntities([wallCalcLayer], activeProject.data.entities, activeProject.data.blocks, activeProject.data.blockBasePoints);
    } else {
        const rawWallLayers = activeProject.layerConfig[SemanticLayer.WALL];
        walls = extractEntities(rawWallLayers, activeProject.data.entities, activeProject.data.blocks, activeProject.data.blockBasePoints);
    }
    walls = filterEntitiesInBounds(walls, baseBounds);

    let cols: DxfEntity[] = [];
    const colCalcLayer = activeProject.data.layers.find(l => l === 'COLU_CALC');
    if (colCalcLayer) {
        cols = extractEntities([colCalcLayer], activeProject.data.entities, activeProject.data.blocks, activeProject.data.blockBasePoints);
    } else {
        const rawColLayers = activeProject.layerConfig[SemanticLayer.COLUMN];
        cols = extractEntities(rawColLayers, activeProject.data.entities, activeProject.data.blocks, activeProject.data.blockBasePoints);
    }
    cols = filterEntitiesInBounds(cols, baseBounds);

    const obstacles = [...walls, ...cols];

    // 3. Valid Widths (From Text)
    const labelLayers = activeProject.layerConfig[SemanticLayer.BEAM_LABEL];
    const validWidths = new Set<number>();
    
    const scanForWidths = (ents: DxfEntity[]) => {
        ents.forEach(t => {
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
    };

    scanForWidths(textEntities);
    
    if (labelLayers.length > 0) {
         const rawLabels = extractEntities(labelLayers, activeProject.data.entities, activeProject.data.blocks, activeProject.data.blockBasePoints)
            .filter(e => e.type === EntityType.TEXT);
         const boundedLabels = filterEntitiesInBounds(rawLabels, baseBounds);
         scanForWidths(boundedLabels);
    }

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

export interface OBB {
    center: Point;
    u: Point; // Longitudinal Axis
    v: Point; // Transverse Axis
    halfLen: number;
    halfWidth: number;
    minT: number; // min along U from center
    maxT: number; // max along U from center
    entity: DxfEntity;
}

export const computeOBB = (poly: DxfEntity): OBB | null => {
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

export const rayIntersectsAABB = (origin: Point, dir: Point, bounds: Bounds): { tmin: number, tmax: number } => {
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
export const isBeamFullyAnchored = (beam: DxfEntity, obstacles: DxfEntity[]): boolean => {
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

// --- ALGORITHMS ---

export const mergeCollinearBeams = (
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

    const isGapCrossed = (pStart: Point, pEnd: Point, width: number, beamU: Point): boolean => {
        const mid = { x: (pStart.x + pEnd.x) / 2, y: (pStart.y + pEnd.y) / 2 };
        
        for (const other of allBeamOBBs) {
            const dot = Math.abs(beamU.x * other.u.x + beamU.y * other.u.y);
            if (dot > 0.1) continue; 

            const vDist = Math.abs((mid.x - other.center.x) * other.v.x + (mid.y - other.center.y) * other.v.y);
            const uDist = Math.abs((mid.x - other.center.x) * other.u.x + (mid.y - other.center.y) * other.u.y);

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

                const dot = Math.abs(current.u.x * next.u.x + current.u.y * next.u.y);
                if (dot < 0.98) continue;

                const perpDist = Math.abs((next.center.x - current.center.x) * current.v.x + (next.center.y - current.center.y) * current.v.y);
                if (perpDist > 50) continue;

                const distAlong = (next.center.x - current.center.x) * current.u.x + (next.center.y - current.center.y) * current.u.y;
                const nextStartT = distAlong + next.minT;
                const gap = nextStartT - current.maxT;

                if (gap > maxGap + 10) continue;
                if (Math.abs(current.halfWidth - next.halfWidth) * 2 > 100) continue;

                const pEndCurrent = {
                    x: current.center.x + current.u.x * current.maxT,
                    y: current.center.y + current.u.y * current.maxT
                };
                const pStartNext = {
                    x: current.center.x + current.u.x * nextStartT,
                    y: current.center.y + current.u.y * nextStartT
                };

                if (isGapBlockedByObstacle(pEndCurrent, pStartNext, current.halfWidth * 2)) continue;

                if (strictCrossOnly && gap > 5) {
                    if (!isGapCrossed(pEndCurrent, pStartNext, current.halfWidth * 2, current.u)) {
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

export const extendBeamsToPerpendicular = (
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

export const detectIntersections = (beams: DxfEntity[]): { intersections: DxfEntity[], labels: DxfEntity[], info: BeamIntersectionInfo[] } => {
    const obbs = beams.map(b => ({ obb: computeOBB(b), beam: b }));
    const boundsList = beams.map(b => getEntityBounds(b));

    const clusters = new Map<string, { bounds: Bounds, beams: Set<number> }>();

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
        if (minX < maxX - 10 && minY < maxY - 10) {
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
            if (oriA === oriB) continue;

            const overlap = overlapBounds(bA, bB);
            if (!overlap) continue;

            const cx = (overlap.minX + overlap.maxX) / 2;
            const cy = (overlap.minY + overlap.maxY) / 2;
            const key = `${Math.round(cx / 200)}_${Math.round(cy / 200)}`;

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

    const intersections: DxfEntity[] = [];
    const labels: DxfEntity[] = [];
    let counter = 1;
    const infos: BeamIntersectionInfo[] = [];

    clusters.forEach((val) => {
        const dirs = { right: false, up: false, left: false, down: false };
        const center = { x: (val.bounds.minX + val.bounds.maxX) / 2, y: (val.bounds.minY + val.bounds.maxY) / 2 };
        const tol = 150;

        val.beams.forEach(idx => {
            const { obb } = obbs[idx];
            if (!obb) return;
            const p1 = { x: obb.center.x + obb.u.x * obb.maxT, y: obb.center.y + obb.u.y * obb.maxT };
            const p2 = { x: obb.center.x + obb.u.x * obb.minT, y: obb.center.y + obb.u.y * obb.minT };

            const check = (p: Point) => {
                const dx = p.x - center.x;
                const dy = p.y - center.y;
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
        let shape: IntersectionShape = 'L';
        if (arms === 4) shape = 'C';
        else if (arms === 3) shape = 'T';
        
        let tAngle: number | undefined = undefined;
        if (shape === 'T') {
            // Missing direction determines stem direction
            if (!dirs.down) tAngle = 0;
            else if (!dirs.left) tAngle = 90;
            else if (!dirs.up) tAngle = 180;
            else if (!dirs.right) tAngle = 270;
            if (tAngle === undefined) tAngle = 0;
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

        const labelText = shape === 'T'
            ? `T-${counter}/${tAngle ?? 0}`
            : `${shape}-${counter}`;

        labels.push({
            type: EntityType.TEXT,
            layer: 'BEAM_STEP2_INTER_SECTION',
            start: center,
            text: labelText,
            radius: 250,
            startAngle: 0
        });
        counter++;

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
            angle: tAngle,
            beamIndexes: Array.from(val.beams)
        });
    });

    return { intersections, labels, info: infos };
};

export const mergeOverlappingBeams = (beams: DxfEntity[]): DxfEntity[] => {
    const items = beams.map(b => ({ obb: computeOBB(b), beam: b })).filter(i => i.obb !== null) as { obb: OBB, beam: DxfEntity }[];
    const merged: { obb: OBB, beam: DxfEntity }[] = [];
    const used = new Set<number>();

    const mergeOBBs = (a: OBB, b: OBB): OBB => {
        const u = a.u;
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
