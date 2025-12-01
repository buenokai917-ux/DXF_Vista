import React from 'react';
import { DxfEntity, EntityType, Point, Bounds, ProjectFile } from '../types';
import { extractEntities } from '../utils/dxfHelpers';
import { updateProject, getMergeBaseBounds, findEntitiesInAllProjects, isEntityInBounds, filterEntitiesInBounds } from './structure-common';
import {
    getBeamProperties,
    getCenter,
    findParallelPolygonsBeam,
    getEntityBounds,
    distance,
    boundsOverlap
} from '../utils/geometryUtils';

// --- TYPES & CONSTANTS ---

export type BeamTypeTag = 'MAIN' | 'SECONDARY' | 'UNKNOWN';

interface BeamSegment extends DxfEntity {
    __beamId: string;
    beamType?: BeamTypeTag;
    beamLabel?: string | null;
    beamAngle?: number;
}

export interface SegmentInfo {
    id: string;
    center: Point;
    length: number;
    orientation: BeamOrientation;
    label: string | null;
    type: BeamTypeTag;
    bounds: Bounds;
}

type BeamOrientation = 'H' | 'V';

const BEAM_LAYER_CANDIDATES = ['BEAM', 'BEAM_CON'];
const DEFAULT_BEAM_STAGE_COLORS: Record<string, string> = {
    BEAM_STEP1_RAW: '#10b981',      // Green (Raw Lines)
    BEAM_STEP2_GEO: '#06b6d4',      // Cyan (Processed Geometry)
    BEAM_STEP3_ATTR: '#f59e0b',     // Amber (Attributes)
    BEAM_STEP4_LOGIC: '#8b5cf6',    // Violet (Topology)
    BEAM_STEP5_PROP: '#ec4899',     // Pink (Final)
    BEAM_CALC: '#00FF00'
};

const TYPE_PRIORITY: Record<BeamTypeTag, number> = {
    MAIN: 3,
    SECONDARY: 2,
    UNKNOWN: 1
};

// --- HELPER FUNCTIONS ---

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

const ensureBeamStageColor = (
    layer: string,
    setLayerColors: React.Dispatch<React.SetStateAction<Record<string, string>>>
) => {
    if (DEFAULT_BEAM_STAGE_COLORS[layer]) {
        setLayerColors(prev => {
            if (prev[layer]) return prev;
            return { ...prev, [layer]: DEFAULT_BEAM_STAGE_COLORS[layer] };
        });
    }
};

const attachAttributesToSegments = (
    segments: BeamSegment[],
    textEntities: DxfEntity[]
): BeamSegment[] => {
    return segments.map(seg => {
        const center = getCenter(seg);
        if (!center) return seg;

        // Filter nearby texts
        const candidates = textEntities.filter(t => {
            if (!t.start || !t.text) return false;
            const d = distance(t.start, center);
            if (d > 1500) return false;

            return true;
        });

        // Sort by proximity
        candidates.sort((a, b) => distance(a.start!, center) - distance(b.start!, center));

        let bestLabel: string | null = null;
        let bestType: BeamTypeTag = 'UNKNOWN';

        for (const t of candidates) {
            const { label, type } = parseBeamTypeFromText(t.text);
            if (type !== 'UNKNOWN') {
                bestLabel = label;
                bestType = type;
                break;
            }
        }

        return {
            ...seg,
            beamLabel: bestLabel || seg.beamLabel,
            beamType: bestType !== 'UNKNOWN' ? bestType : seg.beamType
        } as BeamSegment;
    });
};

const groupBeamSegments = (segments: BeamSegment[]): { groups: Map<string, BeamSegment[]>, info: Map<string, SegmentInfo> } => {
    const info = new Map<string, SegmentInfo>();

    segments.forEach(s => {
        const props = getBeamProperties(s);
        const center = getCenter(s) || { x: 0, y: 0 };
        const bounds = getEntityBounds(s) || { minX: 0, minY: 0, maxX: 0, maxY: 0 };
        info.set(s.__beamId, {
            id: s.__beamId,
            center,
            length: props.length,
            orientation: getOrientation(props.angle),
            label: s.beamLabel || null,
            type: s.beamType || 'UNKNOWN',
            bounds
        });
    });

    const uf = new Map<string, string>();
    const find = (i: string): string => {
        if (!uf.has(i)) uf.set(i, i);
        if (uf.get(i) !== i) uf.set(i, find(uf.get(i)!));
        return uf.get(i)!;
    };
    const union = (i: string, j: string) => {
        const rootI = find(i);
        const rootJ = find(j);
        if (rootI !== rootJ) uf.set(rootI, rootJ);
    };

    for (let i = 0; i < segments.length; i++) {
        for (let j = i + 1; j < segments.length; j++) {
            const s1 = segments[i];
            const s2 = segments[j];
            const i1 = info.get(s1.__beamId)!;
            const i2 = info.get(s2.__beamId)!;

            if (i1.orientation !== i2.orientation) continue;

            let connected = false;

            if (i1.orientation === 'H') {
                if (Math.abs(i1.center.y - i2.center.y) < 200) {
                    const b1 = i1.bounds;
                    const b2 = i2.bounds;
                    if (b1.maxX + 100 >= b2.minX && b1.minX - 100 <= b2.maxX) {
                        connected = true;
                    }
                }
            } else {
                if (Math.abs(i1.center.x - i2.center.x) < 200) {
                    const b1 = i1.bounds;
                    const b2 = i2.bounds;
                    if (b1.maxY + 100 >= b2.minY && b1.minY - 100 <= b2.maxY) {
                        connected = true;
                    }
                }
            }

            if (connected) {
                union(s1.__beamId, s2.__beamId);
            }
        }
    }

    const groups = new Map<string, BeamSegment[]>();
    segments.forEach(s => {
        const root = find(s.__beamId);
        if (!groups.has(root)) groups.set(root, []);
        groups.get(root)!.push(s);
    });

    return { groups, info };
};

const collectBeamSources = (
    activeProject: ProjectFile,
    projects: ProjectFile[]
) => {
    if (!activeProject.splitRegions || activeProject.splitRegions.length === 0) {
        alert('Please run "Split Views" first.');
        return null;
    }

    const hasMergeLabel = activeProject.data.layers.includes('MERGE_LABEL');
    if (!hasMergeLabel) console.warn('Beam pipeline requires Merge Views for best results.');

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
    let rawAxisEntities = extractEntities(['AXIS'], activeProject.data.entities, activeProject.data.blocks, activeProject.data.blockBasePoints).filter(e => e.type === EntityType.LINE);
    let rawTextEntities = extractEntities(beamTextLayers, activeProject.data.entities, activeProject.data.blocks, activeProject.data.blockBasePoints)
        .filter(e => e.type === EntityType.TEXT && !e.layer.toUpperCase().startsWith('Z_'));

    const entities = filterEntitiesInBounds(rawEntities, baseBounds);
    const axisEntities = filterEntitiesInBounds(rawAxisEntities, baseBounds);
    const textEntities = filterEntitiesInBounds(rawTextEntities, baseBounds);

    // FIXED OBSTACLE COLLECTION
    let walls: DxfEntity[] = [];
    const wallCalcLayer = activeProject.data.layers.find(l => l === 'WALL_CALC');
    if (wallCalcLayer) {
        walls = extractEntities([wallCalcLayer], activeProject.data.entities, activeProject.data.blocks, activeProject.data.blockBasePoints);
    }
    if (walls.length === 0) {
        const rawWallLayers = activeProject.data.layers.filter(l => /wall|墙/i.test(l) && !l.endsWith('_CALC'));
        walls = extractEntities(rawWallLayers, activeProject.data.entities, activeProject.data.blocks, activeProject.data.blockBasePoints);
    }
    walls = filterEntitiesInBounds(walls, baseBounds);

    let cols: DxfEntity[] = [];
    const colCalcLayer = activeProject.data.layers.find(l => l === 'COLU_CALC');
    if (colCalcLayer) {
        cols = extractEntities([colCalcLayer], activeProject.data.entities, activeProject.data.blocks, activeProject.data.blockBasePoints);
    }
    if (cols.length === 0) {
        const rawColLayers = activeProject.data.layers.filter(l => /colu|column|柱/i.test(l) && !l.endsWith('_CALC'));
        cols = extractEntities(rawColLayers, activeProject.data.entities, activeProject.data.blocks, activeProject.data.blockBasePoints);
    }
    cols = filterEntitiesInBounds(cols, baseBounds);

    if (cols.length < 5) {
        const globalCols = findEntitiesInAllProjects(projects, /colu|column|柱/i);
        if (cols.length === 0) cols = globalCols;
    }

    const obstacles = [...walls, ...cols];

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

    const lines: DxfEntity[] = [];
    const polylines: DxfEntity[] = [];

    entities.forEach(ent => {
        if (ent.type === EntityType.LINE) {
            lines.push(ent);
        } else if (ent.type === EntityType.LWPOLYLINE && ent.vertices && ent.vertices.length > 1) {
            if (ent.closed) polylines.push(ent);
            const verts = ent.vertices;
            for (let i = 0; i < verts.length - 1; i++) {
                lines.push({ type: EntityType.LINE, layer: ent.layer, start: verts[i], end: verts[i + 1] });
            }
            if (ent.closed) {
                lines.push({ type: EntityType.LINE, layer: ent.layer, start: verts[verts.length - 1], end: verts[0] });
            }
        }
    });

    return {
        baseBounds,
        beamTextLayers,
        axisLines,
        textPool,
        obstacles,
        validWidths,
        lines,
        polylines
    };
};

// --- GEOMETRIC OPS FOR HARD SPLIT ---

interface OBB {
    center: Point;
    u: Point; // Longitudinal Axis
    v: Point; // Transverse Axis
    halfLen: number;
    halfWidth: number;
    minT: number; // min T along U relative to center (usually -halfLen)
    maxT: number; // max T along U relative to center (usually +halfLen)
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

const getDynamicMaxExtension = (polys: DxfEntity[], obstacles: DxfEntity[]): number => {
    let maxW = 400; // Default fallback (typical beam/wall width)
    
    // 1. Check beam widths
    for (const p of polys) {
        const obb = computeOBB(p);
        if (obb) { 
            const w = obb.halfWidth * 2; 
            if (w > maxW && w < 900) maxW = w; 
        }
    }
    
    // 2. Check wall/column widths (if available in obstacles)
    for (const o of obstacles) {
         if (o.type === EntityType.LWPOLYLINE && o.closed) {
             const obb = computeOBB(o);
             if (obb) { 
                 const w = obb.halfWidth * 2; 
                 // Consider reasonable structural widths
                 if (w > 100 && w < 900) maxW = Math.max(maxW, w); 
             }
         }
    }
    
    return maxW;
};

// Merge aligned OBBs (Cross + T-Top logic)
// Handles "adjacent" merging where First Rect End <= Second Rect Start
const mergeAlignedPolygons = (polys: DxfEntity[], obstacles: DxfEntity[]): DxfEntity[] => {
    const items = polys.map(p => {
        const obb = computeOBB(p);
        return { poly: p, obb };
    }).filter(i => i.obb !== null) as { poly: DxfEntity, obb: OBB }[];

    if (items.length === 0) return polys;

    // Sort items by coordinate to handle chains more naturally
    // Primary Sort: Orientation (Horz first), then Center Coordinate
    items.sort((a, b) => {
        const isVa = Math.abs(a.obb.u.y) > Math.abs(a.obb.u.x);
        const isVb = Math.abs(b.obb.u.y) > Math.abs(b.obb.u.x);
        if (isVa !== isVb) return isVa ? 1 : -1;
        if (!isVa) return a.obb.center.y - b.obb.center.y || a.obb.center.x - b.obb.center.x;
        return a.obb.center.x - b.obb.center.x || a.obb.center.y - b.obb.center.y;
    });

    const obsBounds = obstacles.map(o => getEntityBounds(o)).filter(b => b !== null) as Bounds[];
    const mergedItems: { poly: DxfEntity, obb: OBB }[] = [];
    const used = new Set<number>();

    const merge = (a: OBB, b: OBB): OBB => {
        const isV = Math.abs(a.u.y) > Math.abs(a.u.x);
        let minU: number, maxU: number;
        let center: Point, width: number;

        if (!isV) { // Horizontal
            const minXa = a.center.x + a.u.x * a.minT;
            const maxXa = a.center.x + a.u.x * a.maxT;
            const minXb = b.center.x + b.u.x * b.minT;
            const maxXb = b.center.x + b.u.x * b.maxT;
            const minX = Math.min(minXa, minXb);
            const maxX = Math.max(maxXa, maxXb);
            const len = maxX - minX;
            center = { x: minX + len / 2, y: (a.center.y + b.center.y) / 2 };
            width = Math.max(a.halfWidth * 2, b.halfWidth * 2);
            minU = -len / 2;
            maxU = len / 2;
            return { ...a, center, halfWidth: width / 2, halfLen: len / 2, minT: minU, maxT: maxU, u: { x: 1, y: 0 }, v: { x: 0, y: 1 } };
        } else { // Vertical
            const minYa = a.center.y + a.u.y * a.minT;
            const maxYa = a.center.y + a.u.y * a.maxT;
            const minYb = b.center.y + b.u.y * b.minT;
            const maxYb = b.center.y + b.u.y * b.maxT;
            const minY = Math.min(minYa, minYb);
            const maxY = Math.max(maxYa, maxYb);
            const len = maxY - minY;
            center = { x: (a.center.x + b.center.x) / 2, y: minY + len / 2 };
            width = Math.max(a.halfWidth * 2, b.halfWidth * 2);
            minU = -len / 2;
            maxU = len / 2;
            return { ...a, center, halfWidth: width / 2, halfLen: len / 2, minT: minU, maxT: maxU, u: { x: 0, y: 1 }, v: { x: -1, y: 0 } };
        }
    };

    const isBlockedByObstacle = (p1: Point, p2: Point): boolean => {
        const d = { x: p2.x - p1.x, y: p2.y - p1.y };
        const dist = Math.sqrt(d.x*d.x + d.y*d.y);
        if (dist === 0) return false;
        const dir = { x: d.x/dist, y: d.y/dist };

        for (const b of obsBounds) {
            const { tmin, tmax } = rayIntersectsAABB(p1, dir, b);
            const start = Math.max(0, tmin);
            const end = Math.min(dist, tmax);
            if (end > start) return true;
        }
        return false;
    };

    for (let i = 0; i < items.length; i++) {
        if (used.has(i)) continue;
        let current = items[i].obb;
        let layer = items[i].poly.layer;
        used.add(i);

        let changed = true;
        while (changed) {
            changed = false;
            for (let j = i + 1; j < items.length; j++) {
                if (used.has(j)) continue;
                const other = items[j].obb;

                // 1. Orientation Check
                const dot = Math.abs(current.u.x * other.u.x + current.u.y * other.u.y);
                if (dot < 0.98) continue;

                // 2. Alignment Check
                const dv = (other.center.x - current.center.x) * current.v.x + (other.center.y - current.center.y) * current.v.y;
                if (Math.abs(dv) > 50) continue;

                // 3. Width Check (Strict for Adjacent Merging)
                // Ensure same width (within tolerance)
                if (Math.abs(current.halfWidth - other.halfWidth) * 2 > 30) continue; 

                // 4. Gap Check
                const du = (other.center.x - current.center.x) * current.u.x + (other.center.y - current.center.y) * current.u.y;
                const minOth = du + other.minT;
                const maxOth = du + other.maxT;
                const minCur = current.minT;
                const maxCur = current.maxT;
                
                const i1 = [minCur, maxCur].sort((a,b)=>a-b);
                const i2 = [minOth, maxOth].sort((a,b)=>a-b);
                
                // Gap is the distance between the intervals
                const gap = Math.max(0, Math.max(i1[0], i2[0]) - Math.min(i1[1], i2[1]));

                // For strict adjacent merging (no big jumps across voids), keep gap small.
                // However, user might want to merge across small construction gaps.
                // 500mm allows merging across a small column or gap.
                if (gap > 600) continue; 

                // 5. Obstacle Block Check (Stop immediately if wall/col in between)
                if (gap > 10) {
                     if (isBlockedByObstacle(current.center, other.center)) continue;
                }

                current = merge(current, other);
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

        const p1 = { x: c.x + u.x * minT - v.x * hw, y: c.y + u.y * minT - v.y * hw };
        const p2 = { x: c.x + u.x * minT + v.x * hw, y: c.y + u.y * minT + v.y * hw };
        const p3 = { x: c.x + u.x * maxT + v.x * hw, y: c.y + u.y * maxT + v.y * hw };
        const p4 = { x: c.x + u.x * maxT - v.x * hw, y: c.y + u.y * maxT - v.y * hw };

        mergedItems.push({
            poly: { type: EntityType.LWPOLYLINE, layer: layer, closed: true, vertices: [p1, p2, p3, p4] },
            obb: current
        });
    }

    return mergedItems.map(m => m.poly);
};

const createSubPoly = (
    center: Point,
    u: Point,
    v: Point,
    width: number,
    tStart: number,
    tEnd: number,
    layer: string
): DxfEntity => {
    const hw = width / 2;
    const b1 = { x: center.x + u.x * tStart, y: center.y + u.y * tStart };
    const b2 = { x: center.x + u.x * tEnd, y: center.y + u.y * tEnd };
    const p1 = { x: b1.x + v.x * hw, y: b1.y + v.y * hw };
    const p2 = { x: b2.x + v.x * hw, y: b2.y + v.y * hw };
    const p3 = { x: b2.x - v.x * hw, y: b2.y - v.y * hw };
    const p4 = { x: b1.x - v.x * hw, y: b1.y - v.y * hw };
    return { type: EntityType.LWPOLYLINE, layer, closed: true, vertices: [p1, p2, p3, p4] };
};

const cutPolygonsByObstacles = (
    polys: DxfEntity[],
    obstacles: DxfEntity[]
): DxfEntity[] => {
    const results: DxfEntity[] = [];
    const project = (p: Point, origin: Point, u: Point) => (p.x - origin.x) * u.x + (p.y - origin.y) * u.y;

    polys.forEach(poly => {
        if (!poly.vertices || poly.vertices.length < 4) { results.push(poly); return; }
        const center = getCenter(poly);
        if (!center) return;
        const p0 = poly.vertices[0];
        const p1 = poly.vertices[1];
        const p3 = poly.vertices[3];
        const v01 = { x: p1.x - p0.x, y: p1.y - p0.y };
        const v03 = { x: p3.x - p0.x, y: p3.y - p0.y };
        const len01 = Math.sqrt(v01.x * v01.x + v01.y * v01.y);
        const len03 = Math.sqrt(v03.x * v03.x + v03.y * v03.y);

        let u: Point, v: Point, width: number;
        if (len01 > len03) {
            u = { x: v01.x / len01, y: v01.y / len01 };
            v = { x: v03.x / len03, y: v03.y / len03 };
            width = len03;
        } else {
            u = { x: v03.x / len03, y: v03.y / len03 };
            v = { x: v01.x / len01, y: v01.y / len01 };
            width = len01;
        }

        let minT = Infinity, maxT = -Infinity;
        poly.vertices.forEach(vert => {
            const t = project(vert, center, u);
            minT = Math.min(minT, t);
            maxT = Math.max(maxT, t);
        });

        const blockers: [number, number][] = [];
        obstacles.forEach(obs => {
            const b = getEntityBounds(obs);
            if (!b) return;
            const polyB = getEntityBounds(poly);
            if (!polyB || !boundsOverlap(polyB, b)) return;

            const obsCorners = [
                { x: b.minX, y: b.minY }, { x: b.maxX, y: b.minY },
                { x: b.maxX, y: b.maxY }, { x: b.minX, y: b.maxY }
            ];

            let oMinV = Infinity, oMaxV = -Infinity;
            let oMinT = Infinity, oMaxT = -Infinity;
            obsCorners.forEach(c => {
                const tv = (c.x - center.x) * v.x + (c.y - center.y) * v.y;
                const tt = (c.x - center.x) * u.x + (c.y - center.y) * u.y;
                oMinV = Math.min(oMinV, tv);
                oMaxV = Math.max(oMaxV, tv);
                oMinT = Math.min(oMinT, tt);
                oMaxT = Math.max(oMaxT, tt);
            });

            // Strict blocking: Only block if significant visual overlap (both axes)
            const overlapVStart = Math.max(-width / 2, oMinV);
            const overlapVEnd = Math.min(width / 2, oMaxV);
            const overlapV = overlapVEnd - overlapVStart;
            
            // 20% width overlap or >10mm to be considered a "cut"
            if (overlapV > Math.min(width * 0.2, 10)) {
                const overlapTStart = Math.max(minT, oMinT);
                const overlapTEnd = Math.min(maxT, oMaxT);
                if (overlapTEnd > overlapTStart) {
                    blockers.push([overlapTStart, overlapTEnd]);
                }
            }
        });

        blockers.sort((a, b) => a[0] - b[0]);
        const merged: [number, number][] = [];
        if (blockers.length > 0) {
            let curr = blockers[0];
            for (let i = 1; i < blockers.length; i++) {
                if (blockers[i][0] < curr[1]) curr[1] = Math.max(curr[1], blockers[i][1]);
                else { merged.push(curr); curr = blockers[i]; }
            }
            merged.push(curr);
        }

        let currentT = minT;
        merged.forEach(blk => {
            if (blk[0] > currentT + 10) {
                const end = Math.min(blk[0], maxT);
                if (end > currentT) results.push(createSubPoly(center, u, v, width, currentT, end, poly.layer));
            }
            currentT = Math.max(currentT, blk[1]);
        });
        if (currentT < maxT - 10) results.push(createSubPoly(center, u, v, width, currentT, maxT, poly.layer));
    });
    return results;
};

// Extends beams to touch/cross perpendicular beams (T-junctions & L-junctions)
const extendBeamsToTargets = (
    polys: DxfEntity[], 
    targets: DxfEntity[], 
    blockers: DxfEntity[],
    maxExtensionLimit: number
): DxfEntity[] => {
    // Cache Target OBBs
    const targetOBBs = targets.map(p => computeOBB(p)).filter(o => o !== null) as OBB[];
    const blockerBounds = blockers.map(b => getEntityBounds(b)).filter(b => b !== null) as Bounds[];

    return polys.map(poly => {
        const obb = computeOBB(poly);
        if (!obb) return poly;
        const { center, u, v, halfWidth, minT, maxT } = obb;

        // Rays from both ends
        const startPt = { x: center.x + u.x * minT, y: center.y + u.y * minT };
        const endPt = { x: center.x + u.x * maxT, y: center.y + u.y * maxT };

        // Helper to find nearest valid extension limit
        const getExtensionDelta = (origin: Point, dir: Point): number => {
            let bestDist = Infinity;
            let hitTarget = false;

            // 1. Check Targets (Beams)
            for (const t of targetOBBs) {
                // Ignore self
                if (t.entity === poly) continue; 
                // Ignore parallel
                if (Math.abs(u.x * t.u.x + u.y * t.u.y) > 0.9) continue; 

                // Check intersection with Target OBB
                // Project Ray Origin onto Target V-axis (width) to check alignment
                const relPos = { x: origin.x - t.center.x, y: origin.y - t.center.y };
                const vDist = Math.abs(relPos.x * t.v.x + relPos.y * t.v.y);
                if (vDist > t.halfLen + 100) continue; 

                // Distance to target center
                const distToCenter = Math.abs((t.center.x - origin.x)*dir.x + (t.center.y - origin.y)*dir.y);
                
                // Check if target is "ahead"
                const dotToCenter = (t.center.x - origin.x)*dir.x + (t.center.y - origin.y)*dir.y;
                if (dotToCenter < 0) continue; 

                // Approximate width extension: extend to center + halfWidth (far edge)
                const distToFarSide = distToCenter + t.halfWidth; 

                if (distToFarSide < bestDist) {
                    bestDist = distToFarSide;
                    hitTarget = true;
                }
            }

            // 2. Check Blockers (Walls/Cols) - Stop Immediately
            for (const b of blockerBounds) {
                 const { tmin, tmax } = rayIntersectsAABB(origin, dir, b);
                 if (tmax > 0 && tmin < bestDist) {
                      // Hit a wall/col before the target beam or end of extension
                      // Stop at entry (tmin).
                      const dist = Math.max(0, tmin);
                      return Math.min(bestDist, dist);
                 }
            }
            
            // Limit extension range
            // Only extend if we hit a target AND the distance is within the max limit (Wall Thickness logic)
            if (hitTarget && bestDist <= maxExtensionLimit + 100) {
                return bestDist;
            }
            return 0;
        };

        const extFront = getExtensionDelta(endPt, u);
        const extBack = getExtensionDelta(startPt, { x: -u.x, y: -u.y });

        if (extFront === 0 && extBack === 0) return poly;

        const newMaxT = maxT + extFront;
        const newMinT = minT - extBack;
        const hw = halfWidth;

        const p1 = { x: center.x + u.x * newMinT + v.x * hw, y: center.y + u.y * newMinT + v.y * hw };
        const p2 = { x: center.x + u.x * newMinT - v.x * hw, y: center.y + u.y * newMinT - v.y * hw };
        const p3 = { x: center.x + u.x * newMaxT - v.x * hw, y: center.y + u.y * newMaxT - v.y * hw };
        const p4 = { x: center.x + u.x * newMaxT + v.x * hw, y: center.y + u.y * newMaxT + v.y * hw };

        return { type: EntityType.LWPOLYLINE, layer: poly.layer, closed: true, vertices: [p1, p2, p3, p4] };
    });
};

// --- PIPELINE STEPS ---

// STEP 1: RAW GENERATION
export const runBeamRawGeneration = (
    activeProject: ProjectFile,
    projects: ProjectFile[],
    setProjects: React.Dispatch<React.SetStateAction<ProjectFile[]>>,
    setLayerColors: React.Dispatch<React.SetStateAction<Record<string, string>>>
) => {
    const sources = collectBeamSources(activeProject, projects);
    if (!sources) return;
    const resultLayer = 'BEAM_STEP1_RAW';
    const contextLayers = ['WALL_CALC', 'COLU_CALC', 'AXIS', ...sources.beamTextLayers];

    // Columns/Walls are highest priority: prefer *_CALC obstacles
    const calcObstacles = sources.obstacles.filter(o => o.layer === 'WALL_CALC' || o.layer === 'COLU_CALC');
    const obstaclesForRaw = calcObstacles.length > 0 ? calcObstacles : sources.obstacles;

    const applyObstacleCuts = (candidates: DxfEntity[]): DxfEntity[] => {
        const cut = cutPolygonsByObstacles(candidates, obstaclesForRaw);
        return cut.filter(p => p.vertices && p.vertices.length >= 4);
    };

    console.log(`Detected valid beam widths from annotation:`, Array.from(sources.validWidths).sort((a, b) => a - b));

    let polys = findParallelPolygonsBeam(
        sources.lines,
        1200,
        resultLayer,
        obstaclesForRaw,
        sources.axisLines,
        sources.textPool,
        sources.validWidths,
        sources.lines
    );
    polys = applyObstacleCuts(polys);

    const explicitPolys = sources.polylines.map(p => ({ ...p, layer: resultLayer }));
    polys = [...polys, ...applyObstacleCuts(explicitPolys)];

    if (polys.length === 0) {
        alert('No beam segments found. Check if BEAM layer is selected and visible.');
        return;
    }

    ensureBeamStageColor(resultLayer, setLayerColors);
    updateProject(activeProject, setProjects, setLayerColors, resultLayer, polys, DEFAULT_BEAM_STAGE_COLORS[resultLayer], contextLayers, true, undefined, []);
    console.log(`Step 1: Found ${polys.length} raw beam candidates.`);
};

// STEP 2: INTERSECTION PROCESSING (Merge, Extend, Cut)
export const runBeamIntersectionProcessing = (
    activeProject: ProjectFile,
    projects: ProjectFile[],
    setProjects: React.Dispatch<React.SetStateAction<ProjectFile[]>>,
    setLayerColors: React.Dispatch<React.SetStateAction<Record<string, string>>>
) => {
    const sources = collectBeamSources(activeProject, projects);
    if (!sources) return;

    // 1. Deep Copy from STEP 1
    const rawLayer = 'BEAM_STEP1_RAW';
    const rawEntities = extractEntities([rawLayer], activeProject.data.entities, activeProject.data.blocks, activeProject.data.blockBasePoints)
        .filter(e => e.type === EntityType.LWPOLYLINE && e.closed);

    if (rawEntities.length === 0) {
         alert('Please run Step 1 (Raw Generation) first.');
         return;
    }

    // Deep copy geometry to ensure we don't modify raw data
    let polys: DxfEntity[] = rawEntities.map(e => ({
        ...e,
        vertices: e.vertices?.map(v => ({...v})),
        layer: 'BEAM_STEP2_GEO'
    }));

    // 2. Obstacles (Strictly Walls & Cols)
    const calcObstacles = sources.obstacles.filter(o => o.layer === 'WALL_CALC' || o.layer === 'COLU_CALC');
    const blockers = calcObstacles.length > 0 ? calcObstacles : sources.obstacles;

    // 3. Merge Aligned (Cross "+" and T-Horizontal "-")
    // Merges collinear segments into single units, including "Adjacent/Touching" cases
    polys = mergeAlignedPolygons(polys, blockers);

    // Calculate dynamic max extension based on found widths (Wall/Beam thickness)
    // This serves as the "Max Wall Thickness" limit for extensions
    const maxExtension = getDynamicMaxExtension(polys, blockers);
    console.log(`Step 2: Dynamic Extension Limit = ${maxExtension}mm`);

    // 4. Extend to Targets (T-Vertical "|" and L-Shape)
    // Extends beams to cover the full width of the crossing beam, limited by maxExtension
    // Stops immediately if a wall/column is encountered
    polys = extendBeamsToTargets(polys, polys, blockers, maxExtension);

    // 5. Final Safety Cut
    // Trims any artifacts that might still overlap walls/cols
    polys = cutPolygonsByObstacles(polys, blockers);

    const resultLayer = 'BEAM_STEP2_GEO';
    const contextLayers = ['WALL_CALC', 'COLU_CALC', 'AXIS', ...sources.beamTextLayers];

    ensureBeamStageColor(resultLayer, setLayerColors);
    updateProject(
        activeProject,
        setProjects,
        setLayerColors,
        resultLayer,
        polys,
        DEFAULT_BEAM_STAGE_COLORS[resultLayer],
        contextLayers,
        true,
        undefined,
        [] // Keep Step 1 visible/available
    );
    console.log(`Step 2: Processed intersections for ${polys.length} beams.`);
};

// STEP 3: ATTRIBUTES
export const runBeamAttributeMounting = (
    activeProject: ProjectFile,
    projects: ProjectFile[],
    setProjects: React.Dispatch<React.SetStateAction<ProjectFile[]>>,
    setLayerColors: React.Dispatch<React.SetStateAction<Record<string, string>>>
) => {
    const sources = collectBeamSources(activeProject, projects);
    if (!sources) return;

    const baseSegments = hydrateBeamSegmentsFromLayer(activeProject, 'BEAM_STEP2_GEO');
    if (baseSegments.length === 0) {
        alert('Please run Step 2 (Intersection Processing) first.');
        return;
    }

    const enriched = attachAttributesToSegments(baseSegments, sources.textPool);
    const resultLayer = 'BEAM_STEP3_ATTR';
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
                text: `${seg.beamLabel || 'UNK'}`,
                radius: 260,
                startAngle: seg.beamAngle || 0
            });
        }
    });

    ensureBeamStageColor(resultLayer, setLayerColors);
    updateProject(activeProject, setProjects, setLayerColors, resultLayer, newEntities, DEFAULT_BEAM_STAGE_COLORS[resultLayer], contextLayers, true, undefined, ['BEAM_STEP2_GEO']);
    console.log(`Step 3: Attributes attached to ${enriched.length} segments.`);
};

// STEP 4: TOPOLOGY MERGE
export const runBeamTopologyMerge = (
    activeProject: ProjectFile,
    projects: ProjectFile[],
    setProjects: React.Dispatch<React.SetStateAction<ProjectFile[]>>,
    setLayerColors: React.Dispatch<React.SetStateAction<Record<string, string>>>
) => {
    const segments = hydrateBeamSegmentsFromLayer(activeProject, 'BEAM_STEP3_ATTR');
    if (segments.length === 0) {
        alert('Please run Step 3 first.');
        return;
    }

    const { groups, info } = groupBeamSegments(segments);
    const resultLayer = 'BEAM_STEP4_LOGIC';
    const contextLayers = ['AXIS', 'WALL', 'COLU'];

    const mergedEntities: DxfEntity[] = [];
    let labelIndex = 1;

    groups.forEach((segs, root) => {
        const groupInfos = segs.map(s => info.get(s.__beamId)).filter((i): i is SegmentInfo => Boolean(i));
        const dominant = groupInfos.reduce((best, curr) => {
            if (!best) return curr;
            const currScore = TYPE_PRIORITY[curr.type] * 10000 + curr.length;
            const bestScore = TYPE_PRIORITY[best.type] * 10000 + best.length;
            return currScore > bestScore ? curr : best;
        }, groupInfos[0] || null);

        const groupType = dominant?.type || 'UNKNOWN';
        const groupLabel = segs.find(s => s.beamLabel)?.beamLabel || dominant?.label || null;

        segs.forEach(seg => {
            mergedEntities.push({
                ...(seg as DxfEntity),
                layer: resultLayer,
                beamType: groupType,
                beamLabel: groupLabel
            } as DxfEntity);
        });

        const center = dominant?.center || getCenter(segs[0]);
        if (center) {
            mergedEntities.push({
                type: EntityType.TEXT,
                layer: resultLayer,
                start: center,
                text: `GRP-${labelIndex}`,
                radius: 200,
                startAngle: 0
            });
        }
        labelIndex++;
    });

    ensureBeamStageColor(resultLayer, setLayerColors);
    updateProject(activeProject, setProjects, setLayerColors, resultLayer, mergedEntities, DEFAULT_BEAM_STAGE_COLORS[resultLayer], contextLayers, true, undefined, ['BEAM_STEP3_ATTR']);
    console.log(`Step 4: Merged into ${groups.size} logical beams.`);
};

// STEP 5: PROPAGATION
export const runBeamPropagation = (
    activeProject: ProjectFile,
    projects: ProjectFile[],
    setProjects: React.Dispatch<React.SetStateAction<ProjectFile[]>>,
    setLayerColors: React.Dispatch<React.SetStateAction<Record<string, string>>>
) => {
    const segments = hydrateBeamSegmentsFromLayer(activeProject, 'BEAM_STEP4_LOGIC');
    if (segments.length === 0) {
        alert('Please run Step 4 first.');
        return;
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

        metas.push({
            id: root,
            segs,
            orientation,
            center: center || { x: 0, y: 0 },
            label: labelSeg?.beamLabel || null,
            type: labelSeg?.beamType || 'UNKNOWN'
        });
    });

    const labeled = metas.filter(m => m.label);
    const unlabeled = metas.filter(m => !m.label);

    unlabeled.forEach(group => {
        const candidates = labeled.filter(l => l.orientation === group.orientation);
        let best: { dist: number, meta: typeof candidates[number] } | null = null;
        candidates.forEach(c => {
            const axisDist = group.orientation === 'H' ? Math.abs(c.center.y - group.center.y) : Math.abs(c.center.x - group.center.x);
            if (axisDist > 20000) return;
            if (axisDist > 500) return;
            const alongDist = distance(c.center, group.center);
            if (!best || alongDist < best.dist) best = { dist: alongDist, meta: c };
        });

        if (best) {
            group.label = best.meta.label;
            group.type = best.meta.type;
        }
    });

    const resultLayer = 'BEAM_STEP5_PROP';
    const contextLayers = ['AXIS', 'WALL', 'COLU'];
    const propagatedEntities: DxfEntity[] = [];

    metas.forEach(meta => {
        const label = meta.label || 'UNLABELED';
        meta.segs.forEach(seg => {
            propagatedEntities.push({
                ...(seg as DxfEntity),
                layer: resultLayer,
                beamType: meta.type,
                beamLabel: label
            } as DxfEntity);
        });
        const center = meta.center;
        propagatedEntities.push({
            type: EntityType.TEXT,
            layer: resultLayer,
            start: center,
            text: `${label}`,
            radius: 340,
            startAngle: 0
        });
    });

    ensureBeamStageColor(resultLayer, setLayerColors);
    updateProject(activeProject, setProjects, setLayerColors, resultLayer, propagatedEntities, DEFAULT_BEAM_STAGE_COLORS[resultLayer], contextLayers, true, undefined, ['BEAM_STEP4_LOGIC']);
    console.log(`Step 5: Finished. Total Labeled: ${metas.filter(m => m.label).length}/${metas.length}.`);
};
