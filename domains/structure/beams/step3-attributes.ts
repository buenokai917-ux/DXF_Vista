
import React from 'react';
import { ProjectFile, DxfEntity, EntityType, Point, Bounds, BeamStep3AttrInfo } from '../../../types';
import { updateProject, isPointInBounds } from '../common';
import { getEntityBounds, distance, getCenter } from '../../../utils/geometryUtils';
import { extractEntities } from '../../../utils/dxfHelpers';
import { collectBeamSources, computeOBB, OBB, DEFAULT_BEAM_STAGE_COLORS } from './common';

interface BeamAttributes {
    code: string; 
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

            const connected = isConnectedAlongAxis(base, curr);
            if (connected) {
                group.push(curr);
            }
            j++;
        }

        const definedAttrs = group.filter(b => b.attr !== null && b.attr.fromLabel).map(b => b.attr!);

        if (definedAttrs.length > 0) {
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
        const infos: BeamStep3AttrInfo[] = beamObbs.map((b, idx) => {
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
