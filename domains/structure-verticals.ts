import React from 'react';
import { EntityType, ProjectFile, DxfEntity, Bounds, Point } from '../types';
import { findParallelPolygons, getEntityBounds, distancePointToLine } from '../utils/geometryUtils';
import { extractEntities } from '../utils/dxfHelpers';
import { updateProject, getMergeBaseBounds, findEntitiesInAllProjects, filterEntitiesInBounds, isEntityInBounds } from './structure-common';

export const runCalculateColumns = (
    activeProject: ProjectFile, 
    projects: ProjectFile[], 
    setProjects: React.Dispatch<React.SetStateAction<ProjectFile[]>>,
    setLayerColors: React.Dispatch<React.SetStateAction<Record<string, string>>>
) => {
    const baseBounds = getMergeBaseBounds(activeProject, 2500);
    const targetLayers = activeProject.data.layers.filter(l => /colu|column|柱/i.test(l));
    const resultLayer = 'COLU_CALC';
    const contextLayers = ['AXIS', 'WALL_CALC', 'BEAM_CALC'];

    let rawEntities = extractEntities(targetLayers, activeProject.data.entities, activeProject.data.blocks, activeProject.data.blockBasePoints);

    rawEntities = filterEntitiesInBounds(rawEntities, baseBounds);

    const columnEntities = rawEntities.filter(e => 
        (e.type === EntityType.LWPOLYLINE && e.closed) ||
        e.type === EntityType.CIRCLE ||
        e.type === EntityType.INSERT
    ).map(e => ({...e, layer: resultLayer}));

    if (columnEntities.length === 0) {
        console.log("No valid column objects found on column layers.");
        return;
    }

    updateProject(activeProject, setProjects, setLayerColors, resultLayer, columnEntities, '#f59e0b', contextLayers, true);
    
    let msg = `Marked ${columnEntities.length} columns.`;
    if (baseBounds) msg += ` (Restricted to ${baseBounds.length} merged regions)`;
    console.log(msg);
};

export const runCalculateWalls = (
    activeProject: ProjectFile, 
    projects: ProjectFile[], 
    setProjects: React.Dispatch<React.SetStateAction<ProjectFile[]>>,
    setLayerColors: React.Dispatch<React.SetStateAction<Record<string, string>>>
) => {
    const baseBounds = getMergeBaseBounds(activeProject, 2500);

    // 1. Prepare Layers
    const targetLayers = activeProject.data.layers.filter(l => /wall|墙/i.test(l));
    
    // 2. Prepare Obstacles (COLUMNS ONLY - Walls stop at columns, but continue through Beams)
    let columnObstacles = findEntitiesInAllProjects(projects, /colu|column|柱/i);
    // Include calculated columns if they exist
    const calcColumns = extractEntities(['COLU_CALC'], activeProject.data.entities, activeProject.data.blocks, activeProject.data.blockBasePoints);
    columnObstacles = [...columnObstacles, ...calcColumns];
    columnObstacles = filterEntitiesInBounds(columnObstacles, baseBounds);

    // 3. Prepare Axis
    const rawAxisEntities = extractEntities(['AXIS'], activeProject.data.entities, activeProject.data.blocks, activeProject.data.blockBasePoints);
    let axisLines: DxfEntity[] = [];
    
    rawAxisEntities.forEach(ent => {
        if (ent.type === EntityType.LINE && ent.start && ent.end) {
            axisLines.push(ent);
        } else if (ent.type === EntityType.LWPOLYLINE && ent.vertices && ent.vertices.length > 1) {
            const verts = ent.vertices;
            for (let i = 0; i < verts.length - 1; i++) {
                axisLines.push({ type: EntityType.LINE, layer: ent.layer, start: verts[i], end: verts[i+1] });
            }
            if (ent.closed && verts.length > 2) {
                axisLines.push({ type: EntityType.LINE, layer: ent.layer, start: verts[verts.length-1], end: verts[0] });
            }
        }
    });

    axisLines = filterEntitiesInBounds(axisLines, baseBounds);
    
    if (axisLines.length === 0) {
        const otherAxis = findEntitiesInAllProjects(projects, /^AXIS$/i);
        otherAxis.forEach(ent => {
             if (ent.type === EntityType.LINE) {
                 if (!baseBounds || isEntityInBounds(ent, baseBounds)) axisLines.push(ent);
             }
        });
    }

    const resultLayer = 'WALL_CALC';
    const contextLayers = ['AXIS', 'COLU', 'BEAM_CALC'];

    // 4. Extract Wall Candidates
    let rawWallEntities = extractEntities(targetLayers, activeProject.data.entities, activeProject.data.blocks, activeProject.data.blockBasePoints);
    rawWallEntities = filterEntitiesInBounds(rawWallEntities, baseBounds);
    
    const candidateLines: DxfEntity[] = [];
    const existingClosedPolygons: DxfEntity[] = [];

    rawWallEntities.forEach(ent => {
        if (ent.type === EntityType.LWPOLYLINE && ent.closed && ent.vertices && ent.vertices.length > 2) {
             existingClosedPolygons.push({ ...ent, layer: resultLayer });
        } else {
             if (ent.type === EntityType.LINE && ent.start && ent.end) {
                 candidateLines.push(ent);
             } else if (ent.type === EntityType.LWPOLYLINE && ent.vertices && ent.vertices.length > 1) {
                const verts = ent.vertices;
                for (let i = 0; i < verts.length; i++) {
                    if (ent.closed && i === verts.length - 1) {
                         const p1 = verts[i];
                         const p2 = verts[0];
                         candidateLines.push({ type: EntityType.LINE, layer: ent.layer, start: p1, end: p2 });
                    } else if (i < verts.length - 1) {
                        const p1 = verts[i];
                        const p2 = verts[i + 1];
                        candidateLines.push({ type: EntityType.LINE, layer: ent.layer, start: p1, end: p2 });
                    }
                }
             }
        }
    });

    // 5. Auto-Detect Thickness
    const estimatedWidths = estimateWallThicknesses(candidateLines);
    if (estimatedWidths.size === 0) {
        // Fallback defaults if detection fails
        estimatedWidths.add(200);
        estimatedWidths.add(240);
        estimatedWidths.add(100);
    }
    const widthStr = Array.from(estimatedWidths).join(', ');

    // Run Algorithm
    const generatedWalls = findParallelPolygons(candidateLines, 600, resultLayer, columnObstacles, axisLines, [], 'WALL', estimatedWidths);
    
    const newEntities: DxfEntity[] = [...generatedWalls, ...existingClosedPolygons];

    if (newEntities.length === 0) {
        console.log("No valid wall segments found.");
        return;
    }

    updateProject(activeProject, setProjects, setLayerColors, resultLayer, newEntities, '#94a3b8', contextLayers, true);
    
    let msg = `Marked ${newEntities.length} wall segments. (Thicknesses: ${widthStr})`;
    if (baseBounds) msg += ` (Restricted to ${baseBounds.length} merged regions)`;
    console.log(msg);
};

// --- WALL THICKNESS ESTIMATION ---
const estimateWallThicknesses = (lines: DxfEntity[]): Set<number> => {
    const thicknessCounts = new Map<number, number>();
    const VALID_THICKNESSES = [100, 120, 150, 180, 200, 240, 250, 300, 350, 370, 400, 500, 600];
    
    // Sample a subset if too many lines to avoid O(N^2) lag
    const sample = lines.length > 2000 ? lines.filter((_, i) => i % 2 === 0) : lines;

    for (let i = 0; i < sample.length; i++) {
        const l1 = sample[i];
        if (!l1.start || !l1.end) continue;
        const v1 = { x: l1.end.x - l1.start.x, y: l1.end.y - l1.start.y };
        const len1 = Math.sqrt(v1.x*v1.x + v1.y*v1.y);
        if (len1 < 100) continue;

        for (let j = i + 1; j < sample.length; j++) {
            const l2 = sample[j];
            if (!l2.start || !l2.end) continue;
            
            // Fast check: length similarity not required for walls (one can be long, one short)
            
            // Check parallelism
            const v2 = { x: l2.end.x - l2.start.x, y: l2.end.y - l2.start.y };
            const len2 = Math.sqrt(v2.x*v2.x + v2.y*v2.y);
            const dot = (v1.x * v2.x + v1.y * v2.y) / (len1 * len2);
            if (Math.abs(dot) < 0.98) continue;

            // Check distance
            const center = { x: (l2.start.x + l2.end.x)/2, y: (l2.start.y + l2.end.y)/2 };
            const dist = distancePointToLine(center, l1.start, l1.end);
            
            if (dist > 50 && dist < 800) {
                // Round to nearest 10
                const rounded = Math.round(dist / 10) * 10;
                thicknessCounts.set(rounded, (thicknessCounts.get(rounded) || 0) + 1);
            }
        }
    }

    const result = new Set<number>();
    // Filter for frequent thicknesses that match standard construction sizes
    thicknessCounts.forEach((count, thick) => {
        if (count > 2) { // Threshold
             // Check if it's close to a standard size or just a very frequent measurement
             const isStandard = VALID_THICKNESSES.some(std => Math.abs(std - thick) <= 5);
             if (isStandard || count > 10) {
                 result.add(thick);
             }
        }
    });
    
    return result;
};