
import React from 'react';
import { ProjectFile, DxfEntity, EntityType, Point, BeamStep3AttrInfo, BeamStep4TopologyInfo } from '../../../types';
import { updateProject } from '../common';
import { getEntityBounds } from '../../../utils/geometryUtils';
import { computeOBB } from './common';

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
    const beamCuts = new Map<number, Array<{min: number, max: number}>>();
    
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

    const getBeamLen = (info: BeamStep3AttrInfo): number => {
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
        }).filter(b => b !== null) as { idx: number, info: BeamStep3AttrInfo, priority: number, len: number }[];

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

            let minP = Infinity;
            let maxP = -Infinity;

            const project = (p: Point) => (p.x - obb.center.x) * obb.u.x + (p.y - obb.center.y) * obb.u.y;

            iPolyPoints.forEach(p => {
                 const t = project(p);
                 minP = Math.min(minP, t);
                 maxP = Math.max(maxP, t);
            });

            if (!beamCuts.has(sec.idx)) beamCuts.set(sec.idx, []);
            beamCuts.get(sec.idx)!.push({ min: minP, max: maxP });
        });
    });

    // 3. Reconstruct Beams
    const finalEntities: DxfEntity[] = [];
    const finalLabels: DxfEntity[] = [];
    const step4Infos: BeamStep4TopologyInfo[] = [];

    let globalBeamCounter = 0;

    infos.forEach(info => {
        const poly: DxfEntity = { type: EntityType.LWPOLYLINE, vertices: info.vertices, closed: true, layer: 'TEMP' };
        const obb = computeOBB(poly);
        if (!obb) return;

        const cuts = beamCuts.get(info.beamIndex);
        let segments = [{ start: obb.minT, end: obb.maxT }];

        if (cuts && cuts.length > 0) {
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

            for (const cut of mergedCuts) {
                const nextSegments: {start: number, end: number}[] = [];
                for (const seg of segments) {
                    if (cut.min > seg.start && cut.max < seg.end) {
                        nextSegments.push({ start: seg.start, end: cut.min });
                        nextSegments.push({ start: cut.max, end: seg.end });
                    }
                    else if (cut.min <= seg.start && cut.max > seg.start && cut.max < seg.end) {
                         nextSegments.push({ start: cut.max, end: seg.end });
                    }
                    else if (cut.min > seg.start && cut.min < seg.end && cut.max >= seg.end) {
                        nextSegments.push({ start: seg.start, end: cut.min });
                    }
                    else if (cut.min <= seg.start && cut.max >= seg.end) {
                    }
                    else {
                        nextSegments.push(seg);
                    }
                }
                segments = nextSegments;
            }
        }

        const { center, u, v, halfWidth } = obb;

        segments.forEach(seg => {
            if (seg.end - seg.start < 10) return;

            const p1 = { x: center.x + u.x * seg.start + v.x * halfWidth, y: center.y + u.y * seg.start + v.y * halfWidth };
            const p2 = { x: center.x + u.x * seg.start - v.x * halfWidth, y: center.y + u.y * seg.start - v.y * halfWidth };
            const p3 = { x: center.x + u.x * seg.end - v.x * halfWidth, y: center.y + u.y * seg.end - v.y * halfWidth };
            const p4 = { x: center.x + u.x * seg.end + v.x * halfWidth, y: center.y + u.y * seg.end + v.y * halfWidth };

            const vertices = [p1, p2, p3, p4];
            
            finalEntities.push({
                type: EntityType.LWPOLYLINE,
                layer: resultLayer,
                closed: true,
                vertices: vertices
            });
            
            const newBeamIndex = ++globalBeamCounter;
            const segLength = seg.end - seg.start;
            const segVol = segLength * (info.width || 0) * (info.height || 0);
            
            if (segLength > 500) {
                 const midT = (seg.start + seg.end) / 2;
                 const midPt = { x: center.x + u.x * midT, y: center.y + u.y * midT };
                 const angleDeg = Math.atan2(u.y, u.x) * 180 / Math.PI;
                 let finalAngle = angleDeg;
                 if (finalAngle > 90 || finalAngle < -90) finalAngle += 180;
                 if (finalAngle > 180) finalAngle -= 360;

                 const lengthText = Math.round(segLength).toString();
                 const labelText = `${newBeamIndex} ${info.code || 'UNK'}\n${lengthText}X${info.width || 0}X${info.height || 0}`;

                 finalLabels.push({
                    type: EntityType.TEXT,
                    layer: resultLayer,
                    text: labelText,
                    start: midPt,
                    radius: 160,
                    startAngle: finalAngle
                 });
            }

            const segBounds = getEntityBounds({ type: EntityType.LWPOLYLINE, layer: resultLayer, vertices: vertices });
            step4Infos.push({
                id: info.id, 
                layer: resultLayer,
                shape: 'rect',
                vertices: vertices,
                bounds: segBounds ? { startX: segBounds.minX, startY: segBounds.minY, endX: segBounds.maxX, endY: segBounds.maxY } : info.bounds,
                center: { x: center.x + u.x * ((seg.start+seg.end)/2), y: center.y + u.y * ((seg.start+seg.end)/2) },
                radius: undefined,
                angle: info.angle,
                beamIndex: newBeamIndex,
                parentBeamIndex: info.beamIndex, 
                code: info.code,
                span: info.span,
                width: info.width || 0,
                height: info.height || 0,
                rawLabel: info.rawLabel,
                length: Math.round(segLength),
                volume: segVol 
            });
        });
    });
    
    setProjects(prev => prev.map(p => {
        if (p.id !== activeProject.id) return p;
        return { ...p, beamStep4TopologyInfos: step4Infos };
    }));

    updateProject(
        activeProject,
        setProjects,
        setLayerColors,
        resultLayer,
        [...finalEntities, ...finalLabels],
        '#ec4899', 
        ['COLU_CALC', 'WALL_CALC'],
        true,
        undefined,
        [prevLayer, 'BEAM_STEP2_INTER_SECTION'] 
    );
    
    console.log(`Step 4: Topology Merge Complete. Generated ${finalEntities.length} fragments.`);
};
