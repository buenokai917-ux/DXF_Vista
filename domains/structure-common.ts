import React from 'react';
import { DxfEntity, ProjectFile, ViewportRegion, Bounds, Point, EntityType } from '../types';
import { extractEntities } from '../utils/dxfHelpers';
import { getEntityBounds, boundsOverlap } from '../utils/geometryUtils';

export const findEntitiesInAllProjects = (
    projects: ProjectFile[], 
    layerNamePattern: RegExp
): DxfEntity[] => {
    let results: DxfEntity[] = [];
    projects.forEach(p => {
        const matchingLayers = p.data.layers.filter(l => layerNamePattern.test(l));
        if (matchingLayers.length > 0) {
            results = results.concat(extractEntities(matchingLayers, p.data.entities, p.data.blocks, p.data.blockBasePoints));
        }
    });
    return results;
};

export const updateProject = (
    activeProject: ProjectFile,
    setProjects: React.Dispatch<React.SetStateAction<ProjectFile[]>>,
    setLayerColors: React.Dispatch<React.SetStateAction<Record<string, string>>>,
    resultLayer: string, 
    newEntities: DxfEntity[], 
    color: string, 
    contextLayers: string[], 
    fillLayer: boolean,
    splitRegionsUpdate?: ViewportRegion[],
    layersToHide: string[] = []
) => {
    const updatedData = {
        ...activeProject.data,
        entities: [...activeProject.data.entities, ...newEntities],
        layers: activeProject.data.layers.includes(resultLayer) ? activeProject.data.layers : [resultLayer, ...activeProject.data.layers]
    };

    setLayerColors(prev => ({ ...prev, [resultLayer]: color }));

    setProjects(prev => prev.map(p => {
        if (p.id === activeProject.id) {
            const newActive = new Set(p.activeLayers);
            newActive.add(resultLayer);
            contextLayers.forEach(l => {
                if (updatedData.layers.includes(l)) newActive.add(l);
            });
            
            // Hide requested layers (e.g. previous pipeline steps)
            layersToHide.forEach(l => newActive.delete(l));
            
            const newFilled = new Set(p.filledLayers);
            if (fillLayer) {
                newFilled.add(resultLayer);
            }

            return { 
                ...p, 
                data: updatedData, 
                activeLayers: newActive, 
                filledLayers: newFilled,
                splitRegions: splitRegionsUpdate || p.splitRegions
            };
        }
        return p;
    }));
};

export const expandBounds = (b: Bounds, margin: number): Bounds => ({
    minX: b.minX - margin,
    minY: b.minY - margin,
    maxX: b.maxX + margin,
    maxY: b.maxY + margin
});

export const isPointInBounds = (p: Point, b: Bounds) => {
    return p.x >= b.minX && p.x <= b.maxX && p.y >= b.minY && p.y <= b.maxY;
};

export const isEntityInBounds = (ent: DxfEntity, boundsList: Bounds[]): boolean => {
    return boundsList.some(b => {
         if (ent.start && isPointInBounds(ent.start, b)) return true;
         if (ent.end && isPointInBounds(ent.end, b)) return true;
         if (ent.type === EntityType.DIMENSION) {
             if (ent.measureStart && isPointInBounds(ent.measureStart, b)) return true;
             if (ent.measureEnd && isPointInBounds(ent.measureEnd, b)) return true;
         }
         const entB = getEntityBounds(ent);
         if (entB) {
             const cx = (entB.minX + entB.maxX)/2;
             const cy = (entB.minY + entB.maxY)/2;
             if (isPointInBounds({x: cx, y: cy}, b)) return true;
             if (boundsOverlap(entB, b)) return true;
         }
         return false;
    });
};

export const filterEntitiesInBounds = (entities: DxfEntity[], boundsList: Bounds[] | null): DxfEntity[] => {
    if (!boundsList || boundsList.length === 0) return entities;
    return entities.filter(e => isEntityInBounds(e, boundsList));
};

export const getMergeBaseBounds = (project: ProjectFile, margin: number = 0): Bounds[] | null => {
    if (!project.splitRegions || project.splitRegions.length === 0) return null;

    return project.splitRegions
        .filter(r => !r.info || r.info.index === 1)
        .map(r => margin > 0 ? expandBounds(r.bounds, margin) : r.bounds);
};

export { boundsOverlap };