
import React from 'react';
import { DxfEntity, EntityType, ProjectFile, ViewportRegion, SemanticLayer } from '../../types';
import { extractEntities } from '../../utils/dxfHelpers';
import { groupEntitiesByProximity, findTitleForBounds, parseViewportTitle } from '../../utils/geometryUtils';
import { saveStoredAnalysis } from '../../utils/analysisStorage';

// --- CONSTANTS ---
const RESULT_LAYER = 'VIEWPORT_CALC';
const DEBUG_LAYER = 'VIEWPORT_DEBUG';
const COLORS = {
    [RESULT_LAYER]: '#FF00FF', // Magenta for Final Box
    [DEBUG_LAYER]: '#444444'   // Dark Gray for Search Bounds
};

// --- 1. CORE CALCULATION (Pure Logic) ---
export const calculateSplitRegions = (activeProject: ProjectFile): ViewportRegion[] | null => {
    const axisLayers = activeProject.layerConfig[SemanticLayer.AXIS];
    if (axisLayers.length === 0) return null;

    const axisLines = extractEntities(axisLayers, activeProject.data.entities, activeProject.data.blocks, activeProject.data.blockBasePoints)
        .filter(e => e.type === EntityType.LINE || e.type === EntityType.LWPOLYLINE);

    if (axisLines.length === 0) return null;

    // Use all text or specific title layers if available
    const titleLayers = activeProject.layerConfig[SemanticLayer.VIEWPORT_TITLE];
    const useSpecificTitleLayers = titleLayers.length > 0;
  
    const allText = extractEntities(
        useSpecificTitleLayers ? titleLayers : activeProject.data.layers, 
        activeProject.data.entities, 
        activeProject.data.blocks, 
        activeProject.data.blockBasePoints
    ).filter(e => e.type === EntityType.TEXT);

    const allLines = extractEntities(activeProject.data.layers, activeProject.data.entities, activeProject.data.blocks, activeProject.data.blockBasePoints)
        .filter(e => e.type === EntityType.LINE || e.type === EntityType.LWPOLYLINE);

    const clusters = groupEntitiesByProximity(axisLines, 5000);
    const regions: ViewportRegion[] = [];

    clusters.forEach((box, i) => {
        const { title } = findTitleForBounds(box, allText, allLines, useSpecificTitleLayers ? '' : undefined);
        const label = title || `BLOCK ${i + 1}`;

        regions.push({
            bounds: box,
            title: label,
            info: parseViewportTitle(label)
        });
    });

    return regions;
};

// --- 2. VISUALIZATION (Pure Rendering) ---
// Transforms semantic ViewportRegion objects into DXF Entities
export const generateSplitRegionEntities = (regions: ViewportRegion[]): { entities: DxfEntity[], layers: string[] } => {
    const newEntities: DxfEntity[] = [];

    regions.forEach(region => {
        // Visual Box
        newEntities.push({
            type: EntityType.LWPOLYLINE,
            layer: RESULT_LAYER,
            closed: true,
            vertices: [
                { x: region.bounds.minX, y: region.bounds.minY },
                { x: region.bounds.maxX, y: region.bounds.minY },
                { x: region.bounds.maxX, y: region.bounds.maxY },
                { x: region.bounds.minX, y: region.bounds.maxY }
            ]
        });

        // Visual Label
        newEntities.push({
            type: EntityType.TEXT,
            layer: RESULT_LAYER,
            text: region.title,
            start: { x: region.bounds.minX, y: region.bounds.maxY + 500 },
            radius: 250 // Font size
        });
    });

    return { 
        entities: newEntities, 
        layers: [RESULT_LAYER] 
    };
};

// --- 3. ORCHESTRATION (Logic + Storage + UI Update) ---

// A. Restore from Storage (Called on Load)
export const restoreSplitRegions = (
    activeProject: ProjectFile,
    savedRegions: ViewportRegion[],
    setProjects: React.Dispatch<React.SetStateAction<ProjectFile[]>>,
    setLayerColors: React.Dispatch<React.SetStateAction<Record<string, string>>>
) => {
    console.log("Restoring Viewport Analysis from storage...");
    const { entities, layers } = generateSplitRegionEntities(savedRegions);
    
    // Update Colors
    setLayerColors(prev => ({ ...prev, ...COLORS }));

    // Update Project
    setProjects(prev => prev.map(p => {
        if (p.id === activeProject.id) {
            // Merge Data
            const updatedData = {
                ...p.data,
                entities: [...p.data.entities, ...entities],
                layers: Array.from(new Set([...p.data.layers, ...layers]))
            };
            
            // Merge Active Layers
            const newActive = new Set(p.activeLayers);
            layers.forEach(l => newActive.add(l));

            return { 
                ...p, 
                data: updatedData, 
                splitRegions: savedRegions, 
                activeLayers: newActive 
            };
        }
        return p;
    }));
};

// B. Calculate New (Called by Button)
export const runCalculateSplitRegions = (
  activeProject: ProjectFile,
  setProjects: React.Dispatch<React.SetStateAction<ProjectFile[]>>,
  setLayerColors: React.Dispatch<React.SetStateAction<Record<string, string>>>,
  suppressAlert = false
): ViewportRegion[] | null => {
  
  const regions = calculateSplitRegions(activeProject);

  if (!regions || regions.length === 0) {
    if (!suppressAlert) alert('Could not determine split regions. Ensure Axis layers are configured.');
    return null;
  }

  // 1. Save to Storage
  saveStoredAnalysis(activeProject.name, { splitRegions: regions });

  // 2. Generate Visualization
  const { entities, layers } = generateSplitRegionEntities(regions);

  // 3. Update Project State
  const updatedData = {
    ...activeProject.data,
    entities: [...activeProject.data.entities, ...entities],
    layers: Array.from(new Set([...activeProject.data.layers, ...layers]))
  };

  setLayerColors(prev => ({ ...prev, ...COLORS }));

  setProjects(prev =>
    prev.map(p => {
      if (p.id === activeProject.id) {
        const newActive = new Set(p.activeLayers);
        layers.forEach(l => newActive.add(l));
        return { ...p, data: updatedData, splitRegions: regions, activeLayers: newActive };
      }
      return p;
    })
  );

  if (!suppressAlert) console.log(`Found ${regions.length} regions.`);
  return regions;
};

export { runMergeViews, restoreMergedViews } from './merge-views';
