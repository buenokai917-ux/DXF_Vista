
import React from 'react';
import { ProjectFile, DxfEntity, EntityType, Point, BeamStep3AttrInfo, BeamStep4TopologyInfo, Bounds, BeamIntersectionInfo } from '../../../types';
import { updateProject } from '../common';
import { getEntityBounds } from '../../../utils/geometryUtils';
import { computeOBB, OBB } from './common';

// --- TYPES ---

interface Fragment {
    id: string; // Unique internal ID (e.g., "F-1", "F-1-A")
    sourceIndex: number; // Link back to Step 3 info
    poly: DxfEntity;
    obb: OBB;
    attr: {
        code: string;
        span: number; // Parsed span count (default 1)
        width: number;
        height: number;
        priority: number; // 2 (High), 1 (Low), 0 (Unknown)
    };
    dirty: boolean; // If true, OBB needs recalculation
}

interface ActiveIntersection {
    info: BeamIntersectionInfo;
    resolved: boolean;
}

// --- HELPER FUNCTIONS ---

const parseSpan = (spanStr?: string | null): number => {
    if (!spanStr) return 1;
    // Extract number from "(2)", "2", etc.
    const match = spanStr.match(/(\d+)/);
    return match ? parseInt(match[1], 10) : 1;
};

const getCodePriority = (code?: string): number => {
    if (!code) return 0;
    const c = code.toUpperCase();
    // High Priority Group: WKL, KL, LL, XL
    if (/^(WKL|KL|LL|XL)/.test(c)) return 2;
    // Low Priority Group: L
    if (c.startsWith('L')) return 1;
    return 0;
};

// Returns TRUE if fragment overlaps the intersection box significantly
const fragmentOverlaps = (frag: Fragment, box: Bounds): boolean => {
    const obb = frag.obb;
    const center = obb.center;
    // Simple AABB check first
    const fBounds = getEntityBounds(frag.poly);
    if (!fBounds) return false;
    
    // Check if bounds overlap
    if (fBounds.maxX < box.minX || fBounds.minX > box.maxX || 
        fBounds.maxY < box.minY || fBounds.minY > box.maxY) return false;

    // More precise OBB check against Box corners
    // Project Box corners onto OBB U/V
    const boxPts = [
        {x: box.minX, y: box.minY}, {x: box.maxX, y: box.minY},
        {x: box.maxX, y: box.maxY}, {x: box.minX, y: box.maxY}
    ];

    let minU = Infinity, maxU = -Infinity;
    let minV = Infinity, maxV = -Infinity;

    boxPts.forEach(p => {
        const dx = p.x - center.x;
        const dy = p.y - center.y;
        const uVal = dx * obb.u.x + dy * obb.u.y;
        const vVal = dx * obb.v.x + dy * obb.v.y;
        
        minU = Math.min(minU, uVal);
        maxU = Math.max(maxU, uVal);
        minV = Math.min(minV, vVal);
        maxV = Math.max(maxV, vVal);
    });

    // Check overlap in U (Length)
    if (maxU < obb.minT || minU > obb.maxT) return false;
    // Check overlap in V (Width)
    if (maxV < -obb.halfWidth || minV > obb.halfWidth) return false;

    return true;
};

// Subtract box from fragment, returning new fragments (0, 1, or 2)
const cutFragment = (frag: Fragment, box: Bounds): Fragment[] => {
    const obb = frag.obb;
    const center = obb.center;
    
    // Project box onto beam axis to find cut interval [tStart, tEnd]
    const boxPts = [
        {x: box.minX, y: box.minY}, {x: box.maxX, y: box.minY},
        {x: box.maxX, y: box.maxY}, {x: box.minX, y: box.maxY}
    ];

    let tMin = Infinity;
    let tMax = -Infinity;

    boxPts.forEach(p => {
        const t = (p.x - center.x) * obb.u.x + (p.y - center.y) * obb.u.y;
        tMin = Math.min(tMin, t);
        tMax = Math.max(tMax, t);
    });

    // Add tolerance to ensure clean cut
    tMin -= 5; 
    tMax += 5;

    // Beam interval
    const bStart = obb.minT;
    const bEnd = obb.maxT;

    // Overlap interval
    const oStart = Math.max(bStart, tMin);
    const oEnd = Math.min(bEnd, tMax);

    if (oStart >= oEnd) return [frag]; // No intersection on axis

    const results: Fragment[] = [];
    const makeFrag = (start: number, end: number, suffix: string): Fragment | null => {
        if (end - start < 50) return null; // Too short, discard
        
        const midT = (start + end) / 2;
        const halfL = (end - start) / 2;
        const newCenter = {
            x: center.x + obb.u.x * midT,
            y: center.y + obb.u.y * midT
        };
        
        const p1 = { x: newCenter.x + obb.u.x * halfL + obb.v.x * obb.halfWidth, y: newCenter.y + obb.u.y * halfL + obb.v.y * obb.halfWidth };
        const p2 = { x: newCenter.x + obb.u.x * halfL - obb.v.x * obb.halfWidth, y: newCenter.y + obb.u.y * halfL - obb.v.y * obb.halfWidth };
        const p3 = { x: newCenter.x - obb.u.x * halfL - obb.v.x * obb.halfWidth, y: newCenter.y - obb.u.y * halfL - obb.v.y * obb.halfWidth };
        const p4 = { x: newCenter.x - obb.u.x * halfL + obb.v.x * obb.halfWidth, y: newCenter.y - obb.u.y * halfL + obb.v.y * obb.halfWidth };

        const newPoly: DxfEntity = {
            type: EntityType.LWPOLYLINE,
            layer: frag.poly.layer,
            closed: true,
            vertices: [p1, p2, p3, p4]
        };
        
        // Recompute OBB immediately
        const newObb = computeOBB(newPoly);
        if (!newObb) return null;

        return {
            ...frag,
            id: frag.id + suffix,
            poly: newPoly,
            obb: newObb,
            dirty: false
        };
    };

    // Case 1: Cut Middle -> Split into 2
    if (oStart > bStart + 10 && oEnd < bEnd - 10) {
        const f1 = makeFrag(bStart, oStart, "-A");
        const f2 = makeFrag(oEnd, bEnd, "-B");
        if (f1) results.push(f1);
        if (f2) results.push(f2);
    } 
    // Case 2: Cut Start
    else if (oStart <= bStart + 10 && oEnd < bEnd - 10) {
        const f1 = makeFrag(oEnd, bEnd, "-T");
        if (f1) results.push(f1);
    }
    // Case 3: Cut End
    else if (oStart > bStart + 10 && oEnd >= bEnd - 10) {
        const f1 = makeFrag(bStart, oStart, "-H");
        if (f1) results.push(f1);
    }
    // Case 4: Total Consume (oStart <= bStart && oEnd >= bEnd) -> Do nothing (drop)
    else {
        // Drop fragment
    }

    return results;
};


// --- MAIN LOGIC ---

export const runBeamTopologyMerge = (
    activeProject: ProjectFile,
    projects: ProjectFile[],
    setProjects: React.Dispatch<React.SetStateAction<ProjectFile[]>>,
    setLayerColors: React.Dispatch<React.SetStateAction<Record<string, string>>>
) => {
    const prevLayers = ['BEAM_STEP3_ATTR', 'BEAM_STEP2_INTER_SECTION'];
    const resultLayer = 'BEAM_STEP4_LOGIC';
    const errorLayer = 'BEAM_STEP4_ERRORS';

    // 1. Load Data
    const infos = activeProject.beamStep3AttrInfos;
    const inters = activeProject.beamStep2InterInfos;
    
    if (!infos || infos.length === 0 || !inters || inters.length === 0) {
        alert("Missing Step 3 attributes or Step 2 intersections.");
        return;
    }

    // 2. Initialize Fragments
    let fragments: Fragment[] = [];
    const unknownCodeFrags: Fragment[] = [];

    infos.forEach((info, idx) => {
        const poly: DxfEntity = { type: EntityType.LWPOLYLINE, vertices: info.vertices, closed: true, layer: 'TEMP' };
        const obb = computeOBB(poly);
        if (!obb) return;

        const f: Fragment = {
            id: `F-${idx}`,
            sourceIndex: info.beamIndex,
            poly: poly,
            obb: obb,
            attr: {
                code: info.code || '',
                span: parseSpan(info.span),
                width: info.width || 0,
                height: info.height || 0,
                priority: getCodePriority(info.code)
            },
            dirty: false
        };
        
        if (!info.code) {
            unknownCodeFrags.push(f);
        }
        fragments.push(f);
    });

    // 3. Initialize Intersections
    const intersections: ActiveIntersection[] = inters.map(i => ({
        info: i,
        resolved: false
    }));

    // Collection for C-Junction errors (Double Span=1)
    const invalidCrossErrors: ActiveIntersection[] = [];

    // --- HELPER: Resolve Intersection Loop ---
    const processIntersections = (
        filterFn: (
            inter: ActiveIntersection, 
            frags: Fragment[]
        ) => { cutIds: string[], resolved: boolean }
    ) => {
        intersections.forEach(inter => {
            // CRITICAL: If already resolved, skip completely to prevent double deletion (vacuum gaps)
            if (inter.resolved) return;

            // Map inter.info.bounds (startX/startY...) to Bounds (minX/minY...)
            const box: Bounds = {
                minX: inter.info.bounds.startX,
                minY: inter.info.bounds.startY,
                maxX: inter.info.bounds.endX,
                maxY: inter.info.bounds.endY
            };

            // Find overlapping fragments dynamically
            const activeFrags = fragments.filter(f => fragmentOverlaps(f, box));
            
            if (activeFrags.length < 2) {
                // If only 0 or 1 beam remains here, effectively resolved or nothing to resolve
                // We mark it true so we don't waste time on it
                inter.resolved = true;
                return;
            }

            const res = filterFn(inter, activeFrags);

            if (res.cutIds.length > 0) {
                // Perform cuts
                const newFragments: Fragment[] = [];
                const idsToRemove = new Set(res.cutIds);

                // Keep fragments NOT being cut
                const kept = fragments.filter(f => !idsToRemove.has(f.id));
                newFragments.push(...kept);

                // Process cuts
                res.cutIds.forEach(id => {
                    const victim = fragments.find(f => f.id === id);
                    if (victim) {
                        const parts = cutFragment(victim, box);
                        newFragments.push(...parts);
                    }
                });

                fragments = newFragments;
            }
            
            // Only update resolved state if the filter logic explicitly says so
            if (res.resolved) {
                inter.resolved = true;
            }
        });
    };

    // --- PASS 1: T & C Rules (Geometry + Literal Span) ---
    console.log("--- Pass 1: T/C Rules ---");
    processIntersections((inter, frags) => {
        const cutIds: string[] = [];
        let resolved = false;

        if (inter.info.junction === 'T') {
            // Updated Rule: Check HEAD span.
            // If Head.span === 1, cut STEM.
            // If Head.span !== 1, ignore (don't resolve).
            
            // Angle 0/180: Head is Horizontal (X-axis). Stem is Vertical (Y-axis).
            // Angle 90/270: Head is Vertical (Y-axis). Stem is Horizontal (X-axis).
            
            const tAngle = inter.info.angle || 0;
            const isHeadHorizontal = (Math.abs(tAngle) < 10 || Math.abs(tAngle - 180) < 10);
            
            // Identify Head and Stem fragments
            const headFrags: Fragment[] = [];
            const stemFrags: Fragment[] = [];

            frags.forEach(f => {
                const fAng = (Math.atan2(f.obb.u.y, f.obb.u.x) * 180 / Math.PI);
                const normAng = Math.abs(fAng) % 180;
                // isFragH means fragment is horizontal (angle close to 0 or 180)
                const isFragH = normAng < 45 || normAng > 135;

                if (isHeadHorizontal) {
                    if (isFragH) headFrags.push(f);
                    else stemFrags.push(f);
                } else {
                    if (!isFragH) headFrags.push(f);
                    else stemFrags.push(f);
                }
            });

            // Check Heads
            // Usually there's only 1 head beam in a T (the top of the T), but slicing might make 2 segments.
            // We check if ANY Head fragment has span=1. If so, we cut ALL stems.
            const headIsSpan1 = headFrags.some(h => h.attr.span === 1);

            if (headIsSpan1) {
                // Cut all stems
                stemFrags.forEach(s => cutIds.push(s.id));
                resolved = true; // Logic applied successfully
            } else {
                // Head is not Span 1. Do not touch. Leave for later passes.
                resolved = false;
            }
        } 
        else if (inter.info.junction === 'C') {
            // Updated C Rule:
            // 1. Check all participating beams for 'span=1'.
            // 2. If mixed (some 1, some not 1): The span=1 beams win. Cut the span!=1 beams.
            // 3. If ALL are span=1: Logic Error. Add to error report. Mark resolved (stop processing).
            // 4. If NONE are span=1: Skip (process in later passes).

            const span1Frags = frags.filter(f => f.attr.span === 1);
            const otherFrags = frags.filter(f => f.attr.span !== 1);

            if (span1Frags.length > 0 && otherFrags.length > 0) {
                // Case: Mixed. Span=1 wins. Cut others.
                otherFrags.forEach(f => cutIds.push(f.id));
                resolved = true;
            } else if (span1Frags.length > 0 && otherFrags.length === 0) {
                // Case: All Span=1. Conflict/Error.
                invalidCrossErrors.push(inter);
                resolved = true; // Mark resolved so we don't try to cut it via Width/Height later.
            } else {
                // Case: None Span=1. Skip to next pass.
                resolved = false;
            }
        }

        return { cutIds, resolved };
    });

    // --- PASS 2: Width Difference ---
    console.log("--- Pass 2: Width Diff ---");
    processIntersections((inter, frags) => {
        // If Pass 1 resolved it (e.g. cut the T-stem), this won't even run for that intersection.
        
        // Sort by Width descending
        // Logic: Wider cuts Narrower (diff > 10)
        
        frags.sort((a, b) => b.attr.width - a.attr.width);
        const maxW = frags[0].attr.width;
        
        const cutIds: string[] = [];
        // Only cut if significantly smaller
        for (let i = 1; i < frags.length; i++) {
            if (maxW - frags[i].attr.width > 10) {
                cutIds.push(frags[i].id);
            }
        }
        
        const remaining = frags.length - cutIds.length;
        // If we reduced it to 1 beam, it is resolved.
        return { cutIds, resolved: remaining === 1 };
    });

    // --- PASS 3: Height Difference ---
    console.log("--- Pass 3: Height Diff ---");
    processIntersections((inter, frags) => {
        // Higher cuts Shorter (diff > 10)
        frags.sort((a, b) => b.attr.height - a.attr.height);
        const maxH = frags[0].attr.height;
        
        const cutIds: string[] = [];
        for (let i = 1; i < frags.length; i++) {
            if (maxH - frags[i].attr.height > 10) {
                cutIds.push(frags[i].id);
            }
        }
        
        const remaining = frags.length - cutIds.length;
        return { cutIds, resolved: remaining === 1 };
    });

    // --- PASS 4: Code Priority ---
    console.log("--- Pass 4: Code Priority ---");
    processIntersections((inter, frags) => {
        // Priority 2 (WKL...) > Priority 1 (L)
        // High cuts Low
        // Equals don't cut
        
        const maxP = Math.max(...frags.map(f => f.attr.priority));
        const cutIds: string[] = [];

        frags.forEach(f => {
            if (f.attr.priority < maxP) {
                cutIds.push(f.id);
            }
        });

        const remaining = frags.length - cutIds.length;
        return { cutIds, resolved: remaining === 1 };
    });

    // --- PASS 5: Strong Span Logic (Iterative) ---
    console.log("--- Pass 5: Strong Span Rules ---");
    // Retry loop 3 times
    for (let attempt = 0; attempt < 3; attempt++) {
        // 1. Count Segments Globally
        const counts = new Map<string, number>();
        fragments.forEach(f => {
            if (f.attr.code) {
                counts.set(f.attr.code, (counts.get(f.attr.code) || 0) + 1);
            }
        });

        let changedAny = false;

        processIntersections((inter, frags) => {
            // Already resolved by Pass 1-4? Skip.
            if (inter.resolved) return { cutIds: [], resolved: true };
            if (frags.length < 2) return { cutIds: [], resolved: true };

            const cutIds: string[] = [];
            
            // Try to find "Satisfied" beams (Current >= Defined Span)
            const satisfied = frags.filter(f => {
                const currentCount = counts.get(f.attr.code) || 0;
                return currentCount >= f.attr.span;
            });

            // Case A: Mixed (Some satisfied, some not)
            // Rule: Satisfied beats Unsatisfied.
            if (satisfied.length > 0 && satisfied.length < frags.length) {
                const satisfiedIds = new Set(satisfied.map(f => f.id));
                frags.forEach(f => {
                    if (!satisfiedIds.has(f.id)) {
                        cutIds.push(f.id);
                    }
                });
                if (cutIds.length > 0) changedAny = true;
                return { cutIds, resolved: true };
            }

            // Case B: All Satisfied (Deadlock?)
            // Rule: If T-Junction and both satisfied, CUT STEM.
            // Rationale: Cutting stem in T removes the overlap but doesn't split the beam into two (it just stops at the head).
            if (satisfied.length === frags.length) {
                if (inter.info.junction === 'T') {
                    // Identify Stem vs Head based on T-Angle
                    const tAngle = inter.info.angle || 0;
                    const isHeadHorizontal = (Math.abs(tAngle) < 10 || Math.abs(tAngle - 180) < 10);
                    
                    const stemFrags: Fragment[] = [];

                    frags.forEach(f => {
                        const fAng = (Math.atan2(f.obb.u.y, f.obb.u.x) * 180 / Math.PI);
                        const normAng = Math.abs(fAng) % 180;
                        const isFragH = normAng < 45 || normAng > 135;

                        // Head orientation vs Fragment orientation determines role
                        if (isHeadHorizontal) {
                            if (!isFragH) stemFrags.push(f);
                        } else {
                            if (isFragH) stemFrags.push(f);
                        }
                    });

                    if (stemFrags.length > 0) {
                        stemFrags.forEach(s => cutIds.push(s.id));
                        changedAny = true;
                        return { cutIds, resolved: true };
                    }
                }
            }
            
            return { cutIds, resolved: false };
        });

        if (!changedAny) break; 
    }

    // --- CLEANUP ---
    // Remove small fragments (< 500mm)
    fragments = fragments.filter(f => {
        return f.obb.halfLen * 2 >= 500;
    });

    // --- OUTPUT GENERATION ---
    const resultEntities: DxfEntity[] = [];
    const labels: DxfEntity[] = [];
    const topoInfos: BeamStep4TopologyInfo[] = [];
    let fragmentCounter = 0;

    fragments.forEach(f => {
        fragmentCounter++;
        const newIdx = fragmentCounter; // Reset index for clean 1..N
        
        // Entity
        const newEnt: DxfEntity = {
            ...f.poly,
            layer: resultLayer
        };
        resultEntities.push(newEnt);

        // Label
        const center = f.obb.center;
        const angleDeg = Math.atan2(f.obb.u.y, f.obb.u.x) * 180 / Math.PI;
        let finalAngle = angleDeg;
        if (finalAngle > 90 || finalAngle < -90) finalAngle += 180;
        if (finalAngle > 180) finalAngle -= 360;

        const len = Math.round(f.obb.halfLen * 2);
        const labelText = `${newIdx} ${f.attr.code || '?'}\n${len}x${f.attr.width}x${f.attr.height}`;
        
        labels.push({
            type: EntityType.TEXT,
            layer: resultLayer,
            text: labelText,
            start: center,
            radius: 150,
            startAngle: finalAngle
        });

        // Topology Info
        const b = getEntityBounds(newEnt);
        topoInfos.push({
            id: `TOPO-${newIdx}`,
            layer: resultLayer,
            shape: 'rect',
            vertices: newEnt.vertices || [],
            bounds: b ? { startX: b.minX, startY: b.minY, endX: b.maxX, endY: b.maxY } : { startX: 0, startY: 0, endX: 0, endY: 0 },
            center: center,
            angle: angleDeg,
            beamIndex: newIdx,
            parentBeamIndex: f.sourceIndex, // Keep traceability
            code: f.attr.code,
            span: f.attr.span > 1 ? `(${f.attr.span})` : null,
            width: f.attr.width,
            height: f.attr.height,
            rawLabel: '',
            length: len,
            volume: len * f.attr.width * f.attr.height
        });
    });

    // Unknown Code Markers
    const errorMarkers: DxfEntity[] = [];
    unknownCodeFrags.forEach(f => {
        errorMarkers.push({
            type: EntityType.CIRCLE,
            layer: errorLayer,
            center: f.obb.center,
            radius: 300
        });
        errorMarkers.push({
            type: EntityType.TEXT,
            layer: errorLayer,
            text: "UNK",
            start: f.obb.center,
            radius: 150,
            startAngle: 0
        });
    });

    // Invalid Cross Error Markers (Double Span=1)
    invalidCrossErrors.forEach(i => {
         const cx = (i.info.bounds.startX + i.info.bounds.endX)/2;
         const cy = (i.info.bounds.startY + i.info.bounds.endY)/2;
         errorMarkers.push({
            type: EntityType.LWPOLYLINE,
            layer: errorLayer,
            closed: true,
            vertices: i.info.vertices
         });
         errorMarkers.push({
            type: EntityType.TEXT,
            layer: errorLayer,
            text: "ERR-SPAN1",
            start: {x: cx, y: cy},
            radius: 150
         });
    });

    // Unresolved Intersections Markers
    intersections.filter(i => !i.resolved).forEach(i => {
         const cx = (i.info.bounds.startX + i.info.bounds.endX)/2;
         const cy = (i.info.bounds.startY + i.info.bounds.endY)/2;
         errorMarkers.push({
            type: EntityType.LWPOLYLINE,
            layer: errorLayer,
            closed: true,
            vertices: i.info.vertices
         });
         errorMarkers.push({
            type: EntityType.TEXT,
            layer: errorLayer,
            text: "CHK",
            start: {x: cx, y: cy},
            radius: 150
         });
    });

    // Update Project
    setProjects(prev => prev.map(p => {
        if (p.id !== activeProject.id) return p;
        return {
            ...p,
            beamStep4TopologyInfos: topoInfos
        };
    }));

    // Update Display
    updateProject(
        activeProject,
        setProjects,
        setLayerColors,
        resultLayer,
        [...resultEntities, ...labels, ...errorMarkers],
        '#ec4899', // Pink
        ['AXIS', 'COLU_CALC'],
        true,
        undefined,
        prevLayers
    );

    if (errorMarkers.length > 0) {
        setLayerColors(prev => ({...prev, [errorLayer]: '#ef4444'})); // Red
        setProjects(prev => prev.map(p => {
            if (p.id !== activeProject.id) return p;
            const newLayers = p.data.layers.includes(errorLayer) ? p.data.layers : [errorLayer, ...p.data.layers];
            const active = new Set(p.activeLayers);
            active.add(errorLayer);
            return {
                ...p,
                data: {...p.data, layers: newLayers},
                activeLayers: active
            };
        }));
    }

    console.log(`Step 4 Complete. Fragments: ${fragments.length}. Unresolved: ${intersections.filter(i => !i.resolved).length}. CrossErrors: ${invalidCrossErrors.length}. Unknowns: ${unknownCodeFrags.length}`);
};
