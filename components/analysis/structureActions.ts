import React from 'react';
import { ProjectFile } from '../../types';
import { calculateSplitRegions } from '../../domains/structure/splitService';
import { calculateMergeViews, MERGE_RESULT_LAYER_COLORS } from '../../domains/structure/mergeService';
import { calculateColumns } from '../../domains/structure/columnService';
import { calculateWalls } from '../../domains/structure/wallService';
import { updateProject } from '../../domains/structure/common';

export const runCalculateSplitRegions = (
  activeProject: ProjectFile,
  setProjects: React.Dispatch<React.SetStateAction<ProjectFile[]>>,
  setLayerColors: React.Dispatch<React.SetStateAction<Record<string, string>>>,
  suppressAlert = false
) => {
  const calc = calculateSplitRegions(activeProject, suppressAlert);
  if (!calc) return null;
  const { updatedData, regions, resultLayer, debugLayer } = calc;

  setLayerColors(prev => ({ ...prev, [resultLayer]: '#FF00FF', [debugLayer]: '#444444' }));

  setProjects(prev =>
    prev.map(p => {
      if (p.id === activeProject.id) {
        const newActive = new Set(p.activeLayers);
        newActive.add(resultLayer);
        return { ...p, data: updatedData, splitRegions: regions, activeLayers: newActive };
      }
      return p;
    })
  );

  if (!suppressAlert) console.log(`Found ${regions.length} regions.`);
  return regions;
};

export const runMergeViews = (
  activeProject: ProjectFile,
  setProjects: React.Dispatch<React.SetStateAction<ProjectFile[]>>,
  setLayerColors: React.Dispatch<React.SetStateAction<Record<string, string>>>
) => {
  const calc = calculateMergeViews(activeProject);

  if (!calc) {
    console.log('Could not identify regions to merge.');
    return;
  }

  const { updatedData, layersAdded, beamLabels, mergedCount } = calc;

  setLayerColors(prev => {
    const next = { ...prev };
    layersAdded.forEach(l => {
      next[l] = MERGE_RESULT_LAYER_COLORS[l] || '#00FFFF';
    });
    return next;
  });

  setProjects(prev =>
    prev.map(p => {
      if (p.id === activeProject.id) {
        const activeLayers = new Set(p.activeLayers);
        layersAdded.forEach(l => activeLayers.add(l));
        return { ...p, data: updatedData, activeLayers, beamLabels };
      }
      return p;
    })
  );

  console.log(`Consolidated labels from ${mergedCount} view groups into ${layersAdded.join(', ')}.`);
};

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
