
import React from 'react';
import { ProjectFile, DxfEntity, EntityType, BeamStep2GeoInfo } from '../../../types';
import { updateProject } from '../common';
import { getCenter, getEntityBounds } from '../../../utils/geometryUtils';
import { computeOBB, collectBeamSources, isBeamFullyAnchored, deepCopyEntities, extendBeamsToPerpendicular, mergeOverlappingBeams, detectIntersections, DEFAULT_BEAM_STAGE_COLORS } from './common';

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
            } as BeamStep2GeoInfo;
        });
        return { ...p, beamStep2GeoInfos: geoInfos };
    }));
    console.log(`Step 2: Processed intersections. Result: ${finalEntities.length} segments.`);
};
