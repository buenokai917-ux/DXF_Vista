
import React from 'react';
import { ProjectFile } from '../../../types';
import { updateProject } from '../common';
import { findParallelPolygons } from '../../../utils/geometryUtils';
import { collectBeamSources, mergeCollinearBeams, DEFAULT_BEAM_STAGE_COLORS } from './common';

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
