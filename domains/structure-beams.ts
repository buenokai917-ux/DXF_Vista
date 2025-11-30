import React from 'react';
import { DxfEntity, EntityType, Point, Bounds, ProjectFile } from '../types';
import { extractEntities } from '../utils/dxfHelpers';
import { updateProject, getMergeBaseBounds, findEntitiesInAllProjects } from './structure-common';
import { 
    getBeamProperties, 
    getCenter, 
    findParallelPolygonsBeam, 
    getEntityBounds, 
    distance, 
    boundsOverlap, 
    isEntityInBounds,
    filterEntitiesInBounds
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
    BEAM_STEP1_SEGMENTS: '#10b981', // Green
    BEAM_STEP2_ATTR: '#06b6d4',     // Cyan/Teal
    BEAM_STEP3_LOGIC: '#f59e0b',    // Amber
    BEAM_STEP4_PROP: '#6366f1',     // Indigo
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
        const center = getCenter(s) || {x:0, y:0};
        const bounds = getEntityBounds(s) || {minX:0, minY:0, maxX:0, maxY:0};
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
    const hasWalls = activeProject.data.layers.includes('WALL_CALC');
    const hasCols = activeProject.data.layers.includes('COLU_CALC');
    
    if (!hasMergeLabel || !hasWalls || !hasCols) {
        console.warn('Beam pipeline requires Merge Views plus Columns and Walls for best results.');
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

    const lines: DxfEntity[] = [];
    const polylines: DxfEntity[] = [];

    entities.forEach(ent => {
        if (ent.type === EntityType.LINE) {
            lines.push(ent);
        } else if (ent.type === EntityType.LWPOLYLINE && ent.vertices && ent.vertices.length > 1) {
            if (ent.closed) polylines.push(ent);
            
            const verts = ent.vertices;
            for(let i=0; i<verts.length - 1; i++) {
                 lines.push({ type: EntityType.LINE, layer: ent.layer, start: verts[i], end: verts[i+1] });
            }
            if (ent.closed) {
                 lines.push({ type: EntityType.LINE, layer: ent.layer, start: verts[verts.length-1], end: verts[0] });
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

const extendTJunctions = (
    polys: DxfEntity[],
    validWidths: Set<number>
): DxfEntity[] => {
    // 1. Prepare Spatial Index (or simplified O(N^2) for reasonable N)
    const polyData = polys.map(p => {
        if (!p.vertices || p.vertices.length !== 4) return null;
        const center = getCenter(p);
        if (!center) return null;
        
        const p0 = p.vertices[0];
        const p1 = p.vertices[1];
        const p3 = p.vertices[3];
        
        const v01 = { x: p1.x - p0.x, y: p1.y - p0.y };
        const v03 = { x: p3.x - p0.x, y: p3.y - p0.y };
        const len01 = Math.sqrt(v01.x * v01.x + v01.y * v01.y);
        const len03 = Math.sqrt(v03.x * v03.x + v03.y * v03.y);
        
        let u: Point, w: number;
        if (len01 > len03) {
            u = { x: v01.x/len01, y: v01.y/len01 }; // Longitudinal
            w = len03;
        } else {
            u = { x: v03.x/len03, y: v03.y/len03 };
            w = len01;
        }
        
        return {
            entity: p,
            center,
            u,
            w,
            vertices: p.vertices
        };
    }).filter(x => x !== null);

    // 2. Iterate each poly, check ends
    return polyData.map(curr => {
        if (!curr) return polys[0]; 
        
        const project = (p: Point, origin: Point, vec: Point) => (p.x - origin.x)*vec.x + (p.y - origin.y)*vec.y;
        
        let minT = Infinity, maxT = -Infinity;
        curr.vertices.forEach(v => {
            const t = project(v, curr.center, curr.u);
            minT = Math.min(minT, t);
            maxT = Math.max(maxT, t);
        });

        let extendMin = 0;
        let extendMax = 0;

        const maxSearchDist = 2500; // Look ahead

        for (const other of polyData) {
            if (curr === other || !other) continue;
            
            // Check if perpendicular
            const dot = Math.abs(curr.u.x * other.u.x + curr.u.y * other.u.y);
            if (dot > 0.1) continue; 

            // Project "other" center onto "curr" axis
            const projOtherC = project(other.center, curr.center, curr.u);
            
            const distToMin = Math.abs(minT - projOtherC);
            const distToMax = Math.abs(maxT - projOtherC);
            
            // Check lateral alignment (is curr pointing AT other?)
            const projCurrC_onOther = (curr.center.x - other.center.x)*other.u.x + (curr.center.y - other.center.y)*other.u.y;
            
            let otherMin = Infinity, otherMax = -Infinity;
            other.vertices.forEach(v => {
                 const t = (v.x - other.center.x)*other.u.x + (v.y - other.center.y)*other.u.y;
                 otherMin = Math.min(otherMin, t);
                 otherMax = Math.max(otherMax, t);
            });
            
            if (projCurrC_onOther < otherMin || projCurrC_onOther > otherMax) continue; 

            // Check proximity
            if (distToMin < maxSearchDist && distToMin > other.w/2) {
                if (projOtherC < minT) {
                     const expansion = minT - projOtherC; // Extend to CENTERLINE
                     extendMin = Math.max(extendMin, expansion);
                }
            }

            if (distToMax < maxSearchDist && distToMax > other.w/2) {
                if (projOtherC > maxT) {
                     const expansion = projOtherC - maxT; // Extend to CENTERLINE
                     extendMax = Math.max(extendMax, expansion);
                }
            }
        }

        if (extendMin === 0 && extendMax === 0) return curr.entity;

        // Reconstruct Polygon
        const p0 = curr.vertices[0];
        const p1 = curr.vertices[1];
        const p3 = curr.vertices[3]; 
        
        const v01 = { x: p1.x - p0.x, y: p1.y - p0.y };
        const v03 = { x: p3.x - p0.x, y: p3.y - p0.y };
        const len01 = Math.sqrt(v01.x * v01.x + v01.y * v01.y);
        const len03 = Math.sqrt(v03.x * v03.x + v03.y * v03.y);
        
        let vVec: Point;
        let vLen: number;
        if (len01 > len03) {
             vVec = { x: v03.x/len03, y: v03.y/len03 };
             vLen = len03;
        } else {
             vVec = { x: v01.x/len01, y: v01.y/len01 };
             vLen = len01;
        }

        const finalMin = minT - extendMin;
        const finalMax = maxT + extendMax;
        
        const c = curr.center;
        const u = curr.u;
        const v = vVec;
        const hw = vLen/2;

        const newV0 = { x: c.x + u.x*finalMin - v.x*hw, y: c.y + u.y*finalMin - v.y*hw };
        const newV1 = { x: c.x + u.x*finalMax - v.x*hw, y: c.y + u.y*finalMax - v.y*hw };
        const newV2 = { x: c.x + u.x*finalMax + v.x*hw, y: c.y + u.y*finalMax + v.y*hw };
        const newV3 = { x: c.x + u.x*finalMin + v.x*hw, y: c.y + u.y*finalMin + v.y*hw };

        return {
            ...curr.entity,
            vertices: [newV0, newV1, newV2, newV3]
        };
    });
};

const cutPolygonsByObstacles = (
    polys: DxfEntity[],
    obstacles: DxfEntity[]
): DxfEntity[] => {
    const results: DxfEntity[] = [];

    const project = (p: Point, origin: Point, u: Point) => (p.x - origin.x) * u.x + (p.y - origin.y) * u.y;

    polys.forEach(poly => {
        if (!poly.vertices || poly.vertices.length !== 4) {
             results.push(poly);
             return;
        }

        const center = getCenter(poly);
        if (!center) return;

        const p0 = poly.vertices[0];
        const p1 = poly.vertices[1];
        const p3 = poly.vertices[3];
        const v01 = { x: p1.x - p0.x, y: p1.y - p0.y };
        const v03 = { x: p3.x - p0.x, y: p3.y - p0.y };
        const len01 = Math.sqrt(v01.x * v01.x + v01.y * v01.y);
        const len03 = Math.sqrt(v03.x * v03.x + v03.y * v03.y);
        
        let u: Point, v: Point, width: number, length: number;
        if (len01 > len03) {
            u = { x: v01.x/len01, y: v01.y/len01 };
            v = { x: v03.x/len03, y: v03.y/len03 };
            length = len01;
            width = len03;
        } else {
            u = { x: v03.x/len03, y: v03.y/len03 };
            v = { x: v01.x/len01, y: v01.y/len01 };
            length = len03;
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
                {x: b.minX, y: b.minY}, {x: b.maxX, y: b.minY},
                {x: b.maxX, y: b.maxY}, {x: b.minX, y: b.maxY}
            ];
            
            let oMinV = Infinity, oMaxV = -Infinity;
            let oMinT = Infinity, oMaxT = -Infinity;

            obsCorners.forEach(c => {
                const tv = (c.x - center.x)*v.x + (c.y - center.y)*v.y;
                const tt = (c.x - center.x)*u.x + (c.y - center.y)*u.y;
                oMinV = Math.min(oMinV, tv);
                oMaxV = Math.max(oMaxV, tv);
                oMinT = Math.min(oMinT, tt);
                oMaxT = Math.max(oMaxT, tt);
            });

            const overlapVStart = Math.max(-width/2, oMinV);
            const overlapVEnd = Math.min(width/2, oMaxV);

            // Obstacle must overlap significant width to cut
            if (overlapVEnd - overlapVStart > width * 0.3) {
                 blockers.push([oMinT, oMaxT]);
            }
        });

        blockers.sort((a, b) => a[0] - b[0]);
        const mergedBlockers: [number, number][] = [];
        if (blockers.length > 0) {
            let curr = blockers[0];
            for (let i=1; i<blockers.length; i++) {
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

const createSubPoly = (center: Point, u: Point, v: Point, width: number, tStart: number, tEnd: number, layer: string): DxfEntity => {
    const hw = width/2;
    const c1 = { x: center.x + u.x*tStart - v.x*hw, y: center.y + u.y*tStart - v.y*hw };
    const c2 = { x: center.x + u.x*tEnd - v.x*hw, y: center.y + u.y*tEnd - v.y*hw };
    const c3 = { x: center.x + u.x*tEnd + v.x*hw, y: center.y + u.y*tEnd + v.y*hw };
    const c4 = { x: center.x + u.x*tStart + v.x*hw, y: center.y + u.y*tStart + v.y*hw };
    
    return {
        type: EntityType.LWPOLYLINE,
        layer,
        closed: true,
        vertices: [c1, c2, c3, c4]
    };
};

// --- PIPELINE STEPS ---

export const runBeamHardSplit = (
    activeProject: ProjectFile, 
    projects: ProjectFile[], 
    setProjects: React.Dispatch<React.SetStateAction<ProjectFile[]>>,
    setLayerColors: React.Dispatch<React.SetStateAction<Record<string, string>>>
) => {
    const sources = collectBeamSources(activeProject, projects);
    if (!sources) return;
    const resultLayer = 'BEAM_STEP1_SEGMENTS';
    const contextLayers = ['WALL_CALC', 'COLU_CALC', 'AXIS', ...sources.beamTextLayers];

    // 1. Raw Generation (Existing Pair Logic)
    let polys = findParallelPolygonsBeam(
        sources.lines,
        1200,
        resultLayer,
        sources.obstacles,
        sources.axisLines,
        sources.textPool,
        sources.validWidths,
        sources.lines
    );
    
    polys = [...polys, ...sources.polylines.map(p => ({...p, layer: resultLayer}))];

    // 2. T-Junction Extension (Fix gaps)
    polys = extendTJunctions(polys, sources.validWidths);

    // 3. Cut Obstacles (Physical Split)
    const segments = cutPolygonsByObstacles(polys, sources.obstacles);

    if (segments.length === 0) {
        alert('No beam segments found. Check if BEAM layer is selected and visible.');
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
    console.log(`Step 1: Generated ${segments.length} beam segments.`);
};

export const runBeamAttributeMounting = (
    activeProject: ProjectFile, 
    projects: ProjectFile[], 
    setProjects: React.Dispatch<React.SetStateAction<ProjectFile[]>>,
    setLayerColors: React.Dispatch<React.SetStateAction<Record<string, string>>>
) => {
    const sources = collectBeamSources(activeProject, projects);
    if (!sources) return;
    
    // Read from Step 1
    const baseSegments = hydrateBeamSegmentsFromLayer(activeProject, 'BEAM_STEP1_SEGMENTS');
    
    if (baseSegments.length === 0) {
        alert('Please run Step 1 (Hard Split) first.');
        return;
    }

    const enriched = attachAttributesToSegments(baseSegments, sources.textPool);
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
        true
    );
    console.log(`Step 2: Attributes attached to ${enriched.length} segments.`);
};

export const runBeamTopologyMerge = (
    activeProject: ProjectFile, 
    projects: ProjectFile[], 
    setProjects: React.Dispatch<React.SetStateAction<ProjectFile[]>>,
    setLayerColors: React.Dispatch<React.SetStateAction<Record<string, string>>>
) => {
    // Read from Step 2
    const segments = hydrateBeamSegmentsFromLayer(activeProject, 'BEAM_STEP2_ATTR');
    
    if (segments.length === 0) {
        alert('Please run Step 2 first.');
        return;
    }

    const { groups, info } = groupBeamSegments(segments);
    const resultLayer = 'BEAM_STEP3_LOGIC';
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
        true
    );
    console.log(`Step 3: Merged into ${groups.size} logical beams.`);
};

export const runBeamPropagation = (
    activeProject: ProjectFile, 
    projects: ProjectFile[], 
    setProjects: React.Dispatch<React.SetStateAction<ProjectFile[]>>,
    setLayerColors: React.Dispatch<React.SetStateAction<Record<string, string>>>
) => {
    // Read from Step 3
    const segments = hydrateBeamSegmentsFromLayer(activeProject, 'BEAM_STEP3_LOGIC');

    if (segments.length === 0) {
        alert('Please run Step 3 first.');
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

    const resultLayer = 'BEAM_STEP4_PROP';
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
        true
    );
    console.log(`Step 4: Finished. Total Labeled: ${metas.filter(m => m.label).length}/${metas.length}.`);
};