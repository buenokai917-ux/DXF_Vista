import React from 'react';
import { DxfEntity, EntityType, ProjectFile, ViewportRegion, Point, Bounds } from '../types';
import { extractEntities } from '../utils/dxfHelpers';
import { updateProject, boundsOverlap, isPointInBounds, expandBounds } from './structure-common';
import {
    calculateMergeVector,
    getEntityBounds,
    getGridIntersections,
    groupEntitiesByProximity, 
    findTitleForBounds, 
    parseViewportTitle 
} from '../utils/geometryUtils';

export const runCalculateSplitRegions = (
    activeProject: ProjectFile,
    setProjects: React.Dispatch<React.SetStateAction<ProjectFile[]>>,
    setLayerColors: React.Dispatch<React.SetStateAction<Record<string, string>>>,
    suppressAlert = false
): ViewportRegion[] | null => {
    const resultLayer = 'VIEWPORT_CALC';
    const debugLayer = 'VIEWPORT_DEBUG';

    const axisLayers = activeProject.data.layers.filter(l => l.toUpperCase().includes('AXIS'));
    const axisLines = extractEntities(axisLayers, activeProject.data.entities, activeProject.data.blocks, activeProject.data.blockBasePoints)
        .filter(e => e.type === EntityType.LINE || e.type === EntityType.LWPOLYLINE);

    if (axisLines.length === 0) {
         if (!suppressAlert) console.log("No AXIS lines found to determine regions.");
        return null;
    }

    const allText = extractEntities(activeProject.data.layers, activeProject.data.entities, activeProject.data.blocks, activeProject.data.blockBasePoints)
        .filter(e => e.type === EntityType.TEXT);
    
    const allLines = extractEntities(activeProject.data.layers, activeProject.data.entities, activeProject.data.blocks, activeProject.data.blockBasePoints)
        .filter(e => e.type === EntityType.LINE || e.type === EntityType.LWPOLYLINE);

    const clusters = groupEntitiesByProximity(axisLines, 5000); 
    
    const newEntities: DxfEntity[] = [];
    const debugEntities: DxfEntity[] = [];
    const regions: ViewportRegion[] = [];

    clusters.forEach((box, i) => {
        const { title, scannedBounds } = findTitleForBounds(box, allText, allLines);
        const label = title || `BLOCK ${i + 1}`;

        regions.push({
            bounds: box,
            title: label,
            info: parseViewportTitle(label)
        });

        const rect: DxfEntity = {
            type: EntityType.LWPOLYLINE,
            layer: resultLayer,
            closed: true,
            vertices: [
                { x: box.minX, y: box.minY },
                { x: box.maxX, y: box.minY },
                { x: box.maxX, y: box.maxY },
                { x: box.minX, y: box.maxY }
            ]
        };
        newEntities.push(rect);

        newEntities.push({
            type: EntityType.TEXT,
            layer: resultLayer,
            text: label,
            start: { x: box.minX, y: box.maxY + 500 },
            radius: 1000 
        });

        scannedBounds.forEach(sb => {
            debugEntities.push({
                type: EntityType.LWPOLYLINE,
                layer: debugLayer,
                closed: true,
                vertices: [
                    { x: sb.minX, y: sb.minY },
                    { x: sb.maxX, y: sb.minY },
                    { x: sb.maxX, y: sb.maxY },
                    { x: sb.minX, y: sb.maxY }
                ]
            });
        });
    });

    if (newEntities.length === 0) {
        if (!suppressAlert) console.log("Could not determine split regions.");
        return null;
    }

    const updatedData = {
        ...activeProject.data,
        entities: [...activeProject.data.entities, ...newEntities, ...debugEntities],
        layers: [...new Set([...activeProject.data.layers, resultLayer, debugLayer])]
    };

    setLayerColors(prev => ({ ...prev, [resultLayer]: '#FF00FF', [debugLayer]: '#444444' }));

    setProjects(prev => prev.map(p => {
        if (p.id === activeProject.id) {
             const newActive = new Set(p.activeLayers);
             newActive.add(resultLayer);
             return { ...p, data: updatedData, splitRegions: regions, activeLayers: newActive };
        }
        return p;
    }));

    if (!suppressAlert) console.log(`Found ${clusters.length} regions.`);
    return regions;
};

export const runMergeViews = (
    activeProject: ProjectFile,
    setProjects: React.Dispatch<React.SetStateAction<ProjectFile[]>>,
    setLayerColors: React.Dispatch<React.SetStateAction<Record<string, string>>>
) => {
    const regions = activeProject.splitRegions;

    if (!regions || regions.length === 0) {
        console.log("Could not identify regions to merge.");
        return;
    }
    
    const resultLayer = 'MERGE_LABEL';
    const axisLayers = activeProject.data.layers.filter(l => l.toUpperCase().includes('AXIS'));
    const axisLines = extractEntities(axisLayers, activeProject.data.entities, activeProject.data.blocks, activeProject.data.blockBasePoints)
        .filter(e => e.type === EntityType.LINE || e.type === EntityType.LWPOLYLINE);

    const groups: Record<string, ViewportRegion[]> = {};
    regions.forEach(r => {
        const key = r.info ? r.info.prefix : r.title;
        if (!groups[key]) groups[key] = [];
        groups[key].push(r);
    });

    const mergedEntities: DxfEntity[] = [];
    const allEntities = extractEntities(activeProject.data.layers, activeProject.data.entities, activeProject.data.blocks, activeProject.data.blockBasePoints);

    let mergedCount = 0;
    const LABEL_MARGIN = 2000; 

    const isLabelEntity = (ent: DxfEntity): boolean => {
        const u = ent.layer.toUpperCase();
        if (u.includes('AXIS') || u.includes('轴')) return false;
        const layerLooksLabel = u.includes('标注') || u.includes('DIM') || u.includes('LABEL') || /^Z[\u4e00-\u9fa5]/.test(ent.layer);

        if (ent.type === EntityType.DIMENSION) return true;
        if (ent.type === EntityType.TEXT || ent.type === EntityType.ATTRIB) return layerLooksLabel;
        return layerLooksLabel;
    };

    const shouldIncludeEntity = (ent: DxfEntity, bounds: Bounds): boolean => {
         const expanded = expandBounds(bounds, LABEL_MARGIN);
         if (ent.start && isPointInBounds(ent.start, expanded)) return true;
         if (ent.type === EntityType.DIMENSION) {
             if (ent.measureStart && isPointInBounds(ent.measureStart, expanded)) return true;
             if (ent.measureEnd && isPointInBounds(ent.measureEnd, expanded)) return true;
             if (ent.end && isPointInBounds(ent.end, expanded)) return true;
         }
         const b = getEntityBounds(ent);
         if (b) {
             const cx = (b.minX + b.maxX)/2;
             const cy = (b.minY + b.maxY)/2;
             if (isPointInBounds({x: cx, y: cy}, expanded)) return true;
             if (boundsOverlap(b, expanded)) return true;
         }
         return false;
    };

    Object.entries(groups).forEach(([prefix, views]) => {
        views.sort((a, b) => (a.info?.index ?? 1) - (b.info?.index ?? 1));
        const baseView = views[0]; 
        
        allEntities.forEach(ent => {
           if (shouldIncludeEntity(ent, baseView.bounds) && isLabelEntity(ent)) {
               const clone = { ...ent, layer: resultLayer };
               mergedEntities.push(clone);
           }
        });
        
        if (views.length > 1) {
            const baseIntersections = getGridIntersections(baseView.bounds, axisLines);

            for (let i = 1; i < views.length; i++) {
                const targetView = views[i];
                const targetIntersections = getGridIntersections(targetView.bounds, axisLines);
                
                const vec = calculateMergeVector(baseIntersections, targetIntersections);
                
                if (vec) {
                    allEntities.forEach(ent => {
                        if (shouldIncludeEntity(ent, targetView.bounds) && isLabelEntity(ent)) {
                            const clone = { ...ent };
                            clone.layer = resultLayer;
                            
                            if (clone.start) clone.start = { x: clone.start.x + vec.x, y: clone.start.y + vec.y };
                            if (clone.end) clone.end = { x: clone.end.x + vec.x, y: clone.end.y + vec.y };
                            if (clone.center) clone.center = { x: clone.center.x + vec.x, y: clone.center.y + vec.y };
                            if (clone.vertices) clone.vertices = clone.vertices.map(v => ({ x: v.x + vec.x, y: v.y + vec.y }));
                            if (clone.measureStart) clone.measureStart = { x: clone.measureStart.x + vec.x, y: clone.measureStart.y + vec.y };
                            if (clone.measureEnd) clone.measureEnd = { x: clone.measureEnd.x + vec.x, y: clone.measureEnd.y + vec.y };

                            mergedEntities.push(clone);
                        }
                    });
                    mergedCount++;
                }
            }
        }
        mergedCount++;
    });

    if (mergedEntities.length === 0) {
        console.log("No label entities found to merge.");
        return;
    }
    
    updateProject(activeProject, setProjects, setLayerColors, resultLayer, mergedEntities, '#00FFFF', [], false); 
    console.log(`Consolidated labels from ${mergedCount} view groups into '${resultLayer}'.`);
};