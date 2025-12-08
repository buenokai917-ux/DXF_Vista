import React from 'react';
import { ProjectFile } from '../../types';
import { updateProject, getMergeBaseBounds, findEntitiesInAllProjects, filterEntitiesInBounds, isEntityInBounds } from './common';
import { calculateColumns } from './columnService';
import { calculateWalls } from './wallService';

export const runCalculateColumns = (
    activeProject: ProjectFile,
    projects: ProjectFile[],
    setProjects: React.Dispatch<React.SetStateAction<ProjectFile[]>>,
    setLayerColors: React.Dispatch<React.SetStateAction<Record<string, string>>>
) => {
    const calc = calculateColumns(activeProject);
    if (!calc) {
        console.log("No valid column objects found on column layers.");
        return;
    }

    updateProject(
        activeProject,
        setProjects,
        setLayerColors,
        calc.resultLayer,
        calc.entities,
        '#f59e0b',
        calc.contextLayers,
        true,
        undefined,
        undefined,
        () => ({ columns: calc.infos })
    );

    console.log(calc.message);
};

export const runCalculateWalls = (
    activeProject: ProjectFile,
    projects: ProjectFile[],
    setProjects: React.Dispatch<React.SetStateAction<ProjectFile[]>>,
    setLayerColors: React.Dispatch<React.SetStateAction<Record<string, string>>>
) => {
    const calc = calculateWalls(activeProject);
    if (!calc) {
        console.log("No valid wall segments found.");
        return;
    }

    updateProject(
        activeProject,
        setProjects,
        setLayerColors,
        calc.resultLayer,
        calc.entities,
        '#94a3b8',
        calc.contextLayers,
        true,
        undefined,
        undefined,
        () => ({ walls: calc.infos })
    );

    console.log(calc.message);
};

// Legacy exported helpers (still used by beam logic)
export { getMergeBaseBounds, findEntitiesInAllProjects, filterEntitiesInBounds, isEntityInBounds };
