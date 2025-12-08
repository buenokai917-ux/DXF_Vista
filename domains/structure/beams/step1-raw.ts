
import React from 'react';
import { ProjectFile } from '../../../types';
import { updateProject } from '../common';
import { DEFAULT_BEAM_STAGE_COLORS } from './common';
import { calculateBeamRawGeneration } from './beamRawService';

export const runBeamRawGeneration = (
    activeProject: ProjectFile,
    projects: ProjectFile[],
    setProjects: React.Dispatch<React.SetStateAction<ProjectFile[]>>,
    setLayerColors: React.Dispatch<React.SetStateAction<Record<string, string>>>
) => {
    const calc = calculateBeamRawGeneration(activeProject, projects);
    if (!calc) {
        console.log("No beam segments found.");
        return;
    }

    updateProject(
        activeProject,
        setProjects,
        setLayerColors,
        calc.resultLayer,
        calc.entities,
        DEFAULT_BEAM_STAGE_COLORS[calc.resultLayer],
        calc.contextLayers,
        true
    );
    console.log(calc.message);
};
