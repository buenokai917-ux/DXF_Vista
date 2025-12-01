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

    if (!hasMergeLabel) {
        console.warn('Beam pipeline requires Merge Views for best results.');
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
    let rawAxisEntities = extractEntities(['AXIS'], activeProject.data.entities, activeProject.data.blocks, activeProject.data.blockBasePoints).filter(e => e.type === EntityType.LINE);
    let rawTextEntities = extractEntities(beamTextLayers, activeProject.data.entities, activeProject.data.blocks, activeProject.data.blockBasePoints)
        .filter(e => e.type === EntityType.TEXT && !e.layer.toUpperCase().startsWith('Z_'));

    const entities = filterEntitiesInBounds(rawEntities, baseBounds);
    const axisEntities = filterEntitiesInBounds(rawAxisEntities, baseBounds);
    const textEntities = filterEntitiesInBounds(rawTextEntities, baseBounds);

    // FIXED OBSTACLE COLLECTION: Strictly prefer CALC layers if present

    // 1. Walls
    let walls: DxfEntity[] = [];
    const wallCalcLayer = activeProject.data.layers.find(l => l === 'WALL_CALC');
    if (wallCalcLayer) {
        walls = extractEntities([wallCalcLayer], activeProject.data.entities, activeProject.data.blocks, activeProject.data.blockBasePoints);
    }
    // Only fallback if CALC layer is strictly empty or missing
    if (walls.length === 0) {
        const rawWallLayers = activeProject.data.layers.filter(l => /wall|墙/i.test(l) && !l.endsWith('_CALC'));
        walls = extractEntities(rawWallLayers, activeProject.data.entities, activeProject.data.blocks, activeProject.data.blockBasePoints);
    }
    walls = filterEntitiesInBounds(walls, baseBounds);

    // 2. Columns
    let cols: DxfEntity[] = [];
    const colCalcLayer = activeProject.data.layers.find(l => l === 'COLU_CALC');
    if (colCalcLayer) {
        cols = extractEntities([colCalcLayer], activeProject.data.entities, activeProject.data.blocks, activeProject.data.blockBasePoints);
    }
    // Only fallback if CALC layer is strictly empty or missing
    if (cols.length === 0) {
        const rawColLayers = activeProject.data.layers.filter(l => /colu|column|柱/i.test(l) && !l.endsWith('_CALC'));
        cols = extractEntities(rawColLayers, activeProject.data.entities, activeProject.data.blocks, activeProject.data.blockBasePoints);
    }
    cols = filterEntitiesInBounds(cols, baseBounds);

    // Last resort fallback
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

    // 2. Extract Valid Widths from Text
    const textPool = [...textEntities];
    const validWidths = new Set<number>();

    textPool.forEach(t => {
        if (!t.text) return;
        const matches = t.text.match(/^.+\s+(\d+)[xX×]\d+/);
        if (matches) {
            const w = parseInt(matches[1], 10);
            if (!isNaN(w) && w >= 100 && w <= 2000) {
                validWidths.add(w);
            }
        } else {
            const simpleMatch = t.text.match(/^(\d+)[xX×]\d+$/);
            if (simpleMatch) {
                const w = parseInt(simpleMatch[1], 10);
                if (!isNaN(w) && w >= 100 && w <= 2000) {
                    validWidths.add(w);
                }
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

    return {
        center,
        u,
        v,
        halfLen: len / 2,
        halfWidth: width / 2,
        minT,
        maxT,
        entity: poly
    };
};

const rayIntersectsAABB = (origin: Point, dir: Point, bounds: Bounds): { tmin: number, tmax: number } => {
    let tmin = -Infinity;
    let tmax = Infinity;

    if (!origin || !dir) return { tmin: Infinity, tmax: -Infinity };

    // Check X slab
    if (Math.abs(dir.x) > 1e-9) {
        const t1 = (bounds.minX - origin.x) / dir.x;
        const t2 = (bounds.maxX - origin.x) / dir.x;
        tmin = Math.max(tmin, Math.min(t1, t2));
        tmax = Math.min(tmax, Math.max(t1, t2));
    } else if (origin.x < bounds.minX || origin.x > bounds.maxX) {
        return { tmin: Infinity, tmax: -Infinity };
    }

    // Check Y slab
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

const rayIntersectsOBB = (origin: Point, dir: Point, target: OBB): number => {
    if (!origin || !dir || !target || !target.center) return Infinity;

    // Transform Ray to Target Local Space
    const delta = { x: origin.x - target.center.x, y: origin.y - target.center.y };

    // Project delta onto Target axes
    const pU = delta.x * target.u.x + delta.y * target.u.y;
    const pV = delta.x * target.v.x + delta.y * target.v.y;

    // Project ray dir onto Target axes
    const dU = dir.x * target.u.x + dir.y * target.u.y;
    const dV = dir.x * target.v.x + dir.y * target.v.y;

    // Now we have ray: Origin(pU, pV), Dir(dU, dV)

    let tMin = -Infinity, tMax = Infinity;

    // Check V slab (Width)
    if (Math.abs(dV) > 1e-9) {
        const t1 = (-target.halfWidth - pV) / dV;
        const t2 = (target.halfWidth - pV) / dV;
        tMin = Math.max(tMin, Math.min(t1, t2));
        tMax = Math.min(tMax, Math.max(t1, t2));
    } else {
        if (pV < -target.halfWidth || pV > target.halfWidth) return Infinity;
    }

    // Check U slab (Length)
    if (Math.abs(dU) > 1e-9) {
        const t1 = (target.minT - pU) / dU;
        const t2 = (target.maxT - pU) / dU;
        tMin = Math.max(tMin, Math.min(t1, t2));
        tMax = Math.min(tMax, Math.max(t1, t2));
    } else {
        if (pU < target.minT || pU > target.maxT) return Infinity;
    }

    if (tMax < tMin) return Infinity;
    if (tMax < 0) return Infinity;

    return tMin > 0 ? tMin : 0;
};

const mergeAlignedPolygons = (polys: DxfEntity[]): DxfEntity[] => {
    // 1. Convert to OBBs for easier analysis
    const items = polys.map(p => {
        const obb = computeOBB(p);
        return { poly: p, obb };
    }).filter(i => i.obb !== null) as { poly: DxfEntity, obb: OBB }[];

    if (items.length === 0) return polys;

    const mergedItems: { poly: DxfEntity, obb: OBB }[] = [];
    const used = new Set<number>();

    // Helper to merge two OBBs (simple bounding box merge)
    const merge = (a: OBB, b: OBB): OBB => {
        // Assume same orientation
        // construct new bounds in world space if axis aligned
        const isV = Math.abs(a.u.y) > Math.abs(a.u.x);

        let minU: number, maxU: number;
        let center: Point, width: number;

        if (!isV) {
            // Horizontal
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

            return {
                ...a,
                center,
                halfWidth: width / 2,
                halfLen: len / 2,
                minT: minU,
                maxT: maxU,
                u: { x: 1, y: 0 }, v: { x: 0, y: 1 } // Normalize to pure H
            };
        } else {
            // Vertical
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

            return {
                ...a,
                center,
                halfWidth: width / 2,
                halfLen: len / 2,
                minT: minU,
                maxT: maxU,
                u: { x: 0, y: 1 }, v: { x: -1, y: 0 } // Normalize to pure V
            };
        }
    };

    // Sort by "Primary Axis Coordinate" to facilitate bucketing
    // But since we have arbitrary angles, let's just do N^2 pass with `used` set 

    for (let i = 0; i < items.length; i++) {
        if (used.has(i)) continue;
        let current = items[i].obb;
        let layer = items[i].poly.layer;
        used.add(i);

        let changed = true;
        while (changed) {
            changed = false;
            // Try to find a merge candidate
            for (let j = i + 1; j < items.length; j++) {
                if (used.has(j)) continue;
                const other = items[j].obb;

                // 1. Orientation Check
                const dot = Math.abs(current.u.x * other.u.x + current.u.y * other.u.y);
                if (dot < 0.98) continue;

                // 2. Alignment Check (Transverse distance)
                // Project other center onto current V axis
                const dv = (other.center.x - current.center.x) * current.v.x + (other.center.y - current.center.y) * current.v.y;
                if (Math.abs(dv) > 50) continue; // Must be aligned within 50mm

                // 3. Overlap/Touch Check (Longitudinal)
                // Project intervals onto U
                const du = (other.center.x - current.center.x) * current.u.x + (other.center.y - current.center.y) * current.u.y;
                const minOth = du + other.minT;
                const maxOth = du + other.maxT;

                const minCur = current.minT;
                const maxCur = current.maxT;

                // Check gap
                const gap = Math.max(minCur, minOth) - Math.min(maxCur, maxOth);
                // Allow a gap of ~600mm
                if (gap > 600) continue;

                // MERGE
                current = merge(current, other);
                used.add(j);
                changed = true;
            }
        }

        // Reconstruct Poly from merged OBB
        const c = current.center;
        const hw = current.halfWidth;
        const minT = current.minT;
        const maxT = current.maxT;
        const u = current.u;
        const v = current.v;

        const p1 = { x: c.x + u.x * minT - v.x * hw, y: c.y + u.y * minT - v.y * hw };
        const p2 = { x: c.x + u.x * maxT - v.x * hw, y: c.y + u.y * maxT - v.y * hw };
        const p3 = { x: c.x + u.x * maxT + v.x * hw, y: c.y + u.y * maxT + v.y * hw };
        const p4 = { x: c.x + u.x * minT + v.x * hw, y: c.y + u.y * minT + v.y * hw };

        mergedItems.push({
            poly: {
                type: EntityType.LWPOLYLINE,
                layer: layer,
                closed: true,
                vertices: [p1, p2, p3, p4]
            },
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

    // Calculate base points on the centerline
    const b1 = { x: center.x + u.x * tStart, y: center.y + u.y * tStart };
    const b2 = { x: center.x + u.x * tEnd, y: center.y + u.y * tEnd };

    // Calculate corners
    // p1: start-left, p2: end-left, p3: end-right, p4: start-right
    // Note: 'v' is lateral vector
    const p1 = { x: b1.x + v.x * hw, y: b1.y + v.y * hw };
    const p2 = { x: b2.x + v.x * hw, y: b2.y + v.y * hw };
    const p3 = { x: b2.x - v.x * hw, y: b2.y - v.y * hw };
    const p4 = { x: b1.x - v.x * hw, y: b1.y - v.y * hw };

    return {
        type: EntityType.LWPOLYLINE,
        layer,
        closed: true,
        vertices: [p1, p2, p3, p4]
    };
};

const cutPolygonsByObstacles = (
    polys: DxfEntity[],
    obstacles: DxfEntity[]
): DxfEntity[] => {
    const results: DxfEntity[] = [];

    const project = (p: Point, origin: Point, u: Point) => (p.x - origin.x) * u.x + (p.y - origin.y) * u.y;

    polys.forEach(poly => {
        // SAFEGUARD: Ensure vertices exist and have enough points
        if (!poly.vertices || poly.vertices.length < 4) {
            results.push(poly);
            return;
        }

        const center = getCenter(poly);
        if (!center) return;

        const p0 = poly.vertices[0];
        const p1 = poly.vertices[1];
        const p3 = poly.vertices[3];

        // SAFEGUARD: Ensure individual points are valid
        if (!p0 || !p1 || !p3) {
            results.push(poly);
            return;
        }

        const v01 = { x: p1.x - p0.x, y: p1.y - p0.y };
        const v03 = { x: p3.x - p0.x, y: p3.y - p0.y };
        const len01 = Math.sqrt(v01.x * v01.x + v01.y * v01.y);
        const len03 = Math.sqrt(v03.x * v03.x + v03.y * v03.y);

        let u: Point, v: Point, width: number, length: number;
        if (len01 > len03) {
            if (len01 === 0) { results.push(poly); return; } // Protect div by 0
            u = { x: v01.x / len01, y: v01.y / len01 };
            v = { x: v03.x / len03, y: v03.y / len03 };
            length = len01;
            width = len03;
        } else {
            if (len03 === 0) { results.push(poly); return; } // Protect div by 0
            u = { x: v03.x / len03, y: v03.y / len03 };
            v = { x: v01.x / len01, y: v01.y / len01 };
            length = len03;
            width = len01;
        }

        let minT = Infinity, maxT = -Infinity;
        poly.vertices.forEach(vert => {
            if (!vert) return;
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

            const overlapVStart = Math.max(-width / 2, oMinV);
            const overlapVEnd = Math.min(width / 2, oMaxV);

            // STRICTER CHECK: Overlap > 2% width or > 5mm (Very strict to prevent any overlap)
            const overlapV = overlapVEnd - overlapVStart;
            if (overlapV > Math.min(width * 0.02, 5)) {
                blockers.push([oMinT, oMaxT]);
            }
        });

        blockers.sort((a, b) => a[0] - b[0]);
        const mergedBlockers: [number, number][] = [];
        if (blockers.length > 0) {
            let curr = blockers[0];
            for (let i = 1; i < blockers.length; i++) {
                if (blockers[i][0] < curr[1]) {
                    curr[1] = Math.max(curr[1], blockers[i][1]);
                } else {
                    mergedBlockers.push(curr);
                    curr = blockers[i];
                }
            }
            mergedBlockers.push(curr);
        }

        let currentT = minT;
        mergedBlockers.forEach(blk => {
            // Only create segment if gap is substantial (e.g. > 10mm)
            if (blk[0] > currentT + 10) {
                const segEnd = Math.min(blk[0], maxT);
                if (segEnd > currentT) {
                    results.push(createSubPoly(center, u, v, width, currentT, segEnd, poly.layer));
                }
            }
            currentT = Math.max(currentT, blk[1]);
        });

        if (currentT < maxT - 10) {
            results.push(createSubPoly(center, u, v, width, currentT, maxT, poly.layer));
        }
    });

    return results;
};

// --- EXTENSION LOGIC ---

const castRayForExtension = (
    origin: Point,
    dir: Point,
    obstacles: { ent: DxfEntity, bounds: Bounds }[],
    maxDist: number
): number | null => {
    let closest = Infinity;

    obstacles.forEach(obs => {
        const { tmin, tmax } = rayIntersectsAABB(origin, dir, obs.bounds);
        if (tmax < tmin) return; // No intersection
        if (tmin > maxDist) return; // Too far
        if (tmax < 0) return; // Behind

        // We want the first entry point
        const dist = tmin < 0 ? 0 : tmin; // If inside, dist is 0 (or treat as touching)

        // Heuristic: If we are already inside, we don't need to extend.
        // But if we are close (dist > 0 && dist < maxDist), we extend.
        if (dist < closest) {
            closest = dist;
        }
    });

    return closest !== Infinity ? closest : null;
};

const performSmartBeamExtension = (
    polys: DxfEntity[],
    obstacles: DxfEntity[]
): DxfEntity[] => {
    // Pre-compute obstacle bounds
    const obstacleBounds = obstacles
        .map(o => ({ ent: o, bounds: getEntityBounds(o) }))
        .filter(o => o.bounds !== null) as { ent: DxfEntity, bounds: Bounds }[];

    return polys.map(poly => {
        const obb = computeOBB(poly);
        if (!obb) return poly;

        // Use obb.u as direction. obb.minT is 'start' (negative), obb.maxT is 'end' (positive).
        const { center, u, v, halfWidth, minT, maxT } = obb;

        // Current End Points
        const startPt = { x: center.x + u.x * minT, y: center.y + u.y * minT };
        const endPt = { x: center.x + u.x * maxT, y: center.y + u.y * maxT };

        // Ray 1: From endPt in direction u
        const ext1 = castRayForExtension(endPt, u, obstacleBounds, 600);

        // Ray 2: From startPt in direction -u
        const ext2 = castRayForExtension(startPt, { x: -u.x, y: -u.y }, obstacleBounds, 600);

        let newMaxT = maxT;
        let newMinT = minT;

        if (ext1 !== null) newMaxT += ext1;
        if (ext2 !== null) newMinT -= ext2;

        if (newMaxT === maxT && newMinT === minT) return poly;

        // Reconstruct
        const hw = halfWidth;

        // p1/p2 at newMaxT (end)
        // p3/p4 at newMinT (start)

        // Vertices for polygon
        const p_end_left = { x: center.x + u.x * newMaxT + v.x * hw, y: center.y + u.y * newMaxT + v.y * hw };
        const p_end_right = { x: center.x + u.x * newMaxT - v.x * hw, y: center.y + u.y * newMaxT - v.y * hw };
        const p_start_right = { x: center.x + u.x * newMinT - v.x * hw, y: center.y + u.y * newMinT - v.y * hw };
        const p_start_left = { x: center.x + u.x * newMinT + v.x * hw, y: center.y + u.y * newMinT + v.y * hw };

        return {
            type: EntityType.LWPOLYLINE,
            layer: poly.layer,
            closed: true,
            vertices: [p_start_left, p_end_left, p_end_right, p_start_right]
        };
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

    // Use geometric cutting to prevent beams intruding into columns/walls
    const applyObstacleCuts = (candidates: DxfEntity[]): DxfEntity[] => {
        const cut = cutPolygonsByObstacles(candidates, obstaclesForRaw);
        return cut.filter(p => p.vertices && p.vertices.length >= 4);
    };

    console.log(`Detected valid beam widths from annotation:`, Array.from(sources.validWidths).sort((a, b) => a - b));

    // 1. Raw Generation 
    // Uses relaxed geometry rules (see findParallelPolygons in geometryUtils)
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

    // Add explicitly drawn polylines
    const explicitPolys = sources.polylines.map(p => ({ ...p, layer: resultLayer }));
    polys = [...polys, ...applyObstacleCuts(explicitPolys)];

    if (polys.length === 0) {
        alert('No beam segments found. Check if BEAM layer is selected and visible.');
        return;
    }

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
        [] // No previous beam layer to hide
    );
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

    // Read from Step 1
    const rawSegments = hydrateBeamSegmentsFromLayer(activeProject, 'BEAM_STEP1_RAW');
    if (rawSegments.length === 0) {
        alert('Please run Step 1 (Raw Generation) first.');
        return;
    }

    let polys: DxfEntity[] = rawSegments.map(s => s as DxfEntity);
    const allObstacles = sources.obstacles;

    // 1. MERGE COLLINEAR FRAGMENTS
    polys = mergeAlignedPolygons(polys);

    // 2. Smart Extension (Geometric Strictness - check against ALL obstacles)
    polys = performSmartBeamExtension(polys, allObstacles);

    // 3. Cut Obstacles (Physical Split - Smart Cut logic)
    const segments = cutPolygonsByObstacles(polys, allObstacles);

    const resultLayer = 'BEAM_STEP2_GEO';
    const contextLayers = ['WALL_CALC', 'COLU_CALC', 'AXIS', ...sources.beamTextLayers];

    ensureBeamStageColor(resultLayer, setLayerColors);
    updateProject(
        activeProject,
        setProjects,
        setLayerColors,
        resultLayer,
        segments,
        DEFAULT_BEAM_STAGE_COLORS[resultLayer],
        contextLayers,
        true,
        undefined,
        ['BEAM_STEP1_RAW'] // Hide Step 1
    );
    console.log(`Step 2: Processed geometry into ${segments.length} valid segments.`);
}

// STEP 3: ATTRIBUTES
export const runBeamAttributeMounting = (
    activeProject: ProjectFile,
    projects: ProjectFile[],
    setProjects: React.Dispatch<React.SetStateAction<ProjectFile[]>>,
    setLayerColors: React.Dispatch<React.SetStateAction<Record<string, string>>>
) => {
    const sources = collectBeamSources(activeProject, projects);
    if (!sources) return;

    // Read from Step 2
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
    updateProject(
        activeProject,
        setProjects,
        setLayerColors,
        resultLayer,
        newEntities,
        DEFAULT_BEAM_STAGE_COLORS[resultLayer],
        contextLayers,
        true,
        undefined,
        ['BEAM_STEP2_GEO'] // Hide Step 2
    );
    console.log(`Step 3: Attributes attached to ${enriched.length} segments.`);
};

// STEP 4: TOPOLOGY MERGE
export const runBeamTopologyMerge = (
    activeProject: ProjectFile,
    projects: ProjectFile[],
    setProjects: React.Dispatch<React.SetStateAction<ProjectFile[]>>,
    setLayerColors: React.Dispatch<React.SetStateAction<Record<string, string>>>
) => {
    // Read from Step 3
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

        segs.forEach(seg => {
            mergedEntities.push({
                ...(seg as DxfEntity),
                layer: resultLayer,
                beamType: groupType,
                beamLabel: groupLabel
            } as DxfEntity);
        });

        // Add Logic Group ID Tag
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
    updateProject(
        activeProject,
        setProjects,
        setLayerColors,
        resultLayer,
        mergedEntities,
        DEFAULT_BEAM_STAGE_COLORS[resultLayer],
        contextLayers,
        true,
        undefined,
        ['BEAM_STEP3_ATTR'] // Hide Step 3
    );
    console.log(`Step 4: Merged into ${groups.size} logical beams.`);
};

// STEP 5: PROPAGATION
export const runBeamPropagation = (
    activeProject: ProjectFile,
    projects: ProjectFile[],
    setProjects: React.Dispatch<React.SetStateAction<ProjectFile[]>>,
    setLayerColors: React.Dispatch<React.SetStateAction<Record<string, string>>>
) => {
    // Read from Step 4
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

    // Propagation logic: Find nearest identical-orientation beam
    unlabeled.forEach(group => {
        const candidates = labeled.filter(l => l.orientation === group.orientation);
        let best: { dist: number, meta: typeof candidates[number] } | null = null;
        candidates.forEach(c => {
            const axisDist = group.orientation === 'H'
                ? Math.abs(c.center.y - group.center.y)
                : Math.abs(c.center.x - group.center.x);

            // Must be relatively close (e.g. adjacent bays)
            if (axisDist > 20000) return;

            // Favor aligned beams (small axis offset)
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
    updateProject(
        activeProject,
        setProjects,
        setLayerColors,
        resultLayer,
        propagatedEntities,
        DEFAULT_BEAM_STAGE_COLORS[resultLayer],
        contextLayers,
        true,
        undefined,
        ['BEAM_STEP4_LOGIC'] // Hide Step 4
    );
    console.log(`Step 5: Finished. Total Labeled: ${metas.filter(m => m.label).length}/${metas.length}.`);
};
