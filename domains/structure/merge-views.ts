
import React from 'react';
import { DxfEntity, EntityType, ProjectFile, ViewportRegion, Point, Bounds, SemanticLayer, MergedViewData, BeamLabelInfo, ViewMergeMapping } from '../../types';
import { extractEntities } from '../../utils/dxfHelpers';
import { boundsOverlap, expandBounds, isPointInBounds } from './common';
import { saveStoredAnalysis } from '../../utils/analysisStorage';
import {
  calculateMergeVector,
  getEntityBounds,
  getGridIntersections,
  distancePointToLine
} from '../../utils/geometryUtils';
import { updateProject } from './common';

// --- CONSTANTS ---
const RESULT_LAYER_H = 'MERGE_LABEL_H';
const RESULT_LAYER_V = 'MERGE_LABEL_V';
const RESULT_LAYER_VIEW = 'MERGE_VIEW';
const RESULT_COLORS: Record<string, string> = {
  [RESULT_LAYER_H]: '#00FFFF',
  [RESULT_LAYER_V]: '#FF00FF',
  [RESULT_LAYER_VIEW]: '#FFFF00'
};

// --- HELPER FUNCTIONS ---
const normalizeAngle = (deg: number) => {
    let a = deg % 360;
    if (a < 0) a += 360;
    return a;
};
const isHorizontalAngle = (deg: number) => {
    const a = normalizeAngle(deg) % 180;
    return a <= 15 || a >= 165;
};
const isVerticalAngle = (deg: number) => {
    const a = normalizeAngle(deg) % 180;
    return Math.abs(a - 90) <= 15;
};

// --- 1. CALCULATION LOGIC ---

export const calculateMergedViewData = (activeProject: ProjectFile): MergedViewData | null => {
    const regions = activeProject.splitRegions;
    if (!regions || regions.length === 0) return null;

    const axisLayers = activeProject.layerConfig[SemanticLayer.AXIS];
    const axisLines = extractEntities(axisLayers, activeProject.data.entities, activeProject.data.blocks, activeProject.data.blockBasePoints)
        .filter(e => e.type === EntityType.LINE || e.type === EntityType.LWPOLYLINE);

    // Group regions
    const groups: Record<string, ViewportRegion[]> = {};
    regions.forEach(r => {
        const key = r.info ? r.info.prefix : r.title;
        if (!groups[key]) groups[key] = [];
        groups[key].push(r);
    });

    const allEntities = extractEntities(activeProject.data.layers, activeProject.data.entities, activeProject.data.blocks, activeProject.data.blockBasePoints);
    
    // Prepare temporary collection for merged entities to facilitate label parsing
    const tempMergedEntities: { layer: string, ent: DxfEntity }[] = [];
    const mappings: ViewMergeMapping[] = [];

    // Helper to identify label layers
    // EXPLICITLY EXCLUDE IN-SITU LAYERS
    const inSituSet = new Set(activeProject.layerConfig[SemanticLayer.BEAM_IN_SITU_LABEL] || []);
    const labelSet = new Set(activeProject.layerConfig[SemanticLayer.BEAM_LABEL] || []);

    const isLabelLayer = (layer: string) => {
        // 1. If it's explicitly marked as In-Situ, exclude it from MERGE_LABEL_H/V
        if (inSituSet.has(layer)) return false;

        // 2. Strict config check for Beam Labels
        if (labelSet.has(layer)) return true;
        
        // 3. Heuristics (Fallback)
        const u = layer.toUpperCase();
        if (u.includes('AXIS') || u.includes('中心线')) return false;
        // Exclude specific In-Situ keywords if not already caught by config
        if (u.includes('原位') || u.includes('IN-SITU') || u.includes('IN_SITU')) return false;

        return u.includes('标注') || u.includes('DIM') || u.includes('LABEL') || /^Z[\u4e00-\u9fa5]/.test(layer);
    };

    // Helper to detect orientation
    const detectOrientation = (layer: string, ents: DxfEntity[]): 'H' | 'V' => {
        // 1. Name check
        const u = layer.toUpperCase();
        if (layer.includes('水平') || u.includes('HORIZONTAL') || u.includes('_H')) return 'H';
        if (layer.includes('垂直') || layer.includes('竖') || u.includes('VERT') || u.includes('_V')) return 'V';

        // 2. Content check (Leaders)
        let hCount = 0, vCount = 0;
        ents.forEach(e => {
            if (e.type === EntityType.LINE && e.start && e.end) {
                const ang = Math.abs(Math.atan2(e.end.y - e.start.y, e.end.x - e.start.x) * 180 / Math.PI);
                if (isHorizontalAngle(ang)) hCount++;
                else if (isVerticalAngle(ang)) vCount++;
            }
        });
        if (hCount > vCount) return 'H';
        if (vCount > hCount) return 'V';
        
        // 3. Text Check
        let th = 0, tv = 0;
        ents.forEach(e => {
            if (e.type === EntityType.TEXT || e.type === EntityType.ATTRIB) {
                 const rot = e.rotation ?? e.startAngle ?? 0;
                 if (isHorizontalAngle(rot)) th++;
                 else if (isVerticalAngle(rot)) tv++;
            }
        });
        return th >= tv ? 'H' : 'V';
    };

    // Process Groups
    Object.values(groups).forEach(views => {
        views.sort((a, b) => (a.info?.index ?? 1) - (b.info?.index ?? 1));
        const baseView = views[0];
        const baseIntersections = getGridIntersections(baseView.bounds, axisLines);

        views.forEach(view => {
            let vec: Point = { x: 0, y: 0 };
            
            // Calculate Vector (skip for base view itself, vec is 0,0)
            if (view !== baseView) {
                const targetIntersections = getGridIntersections(view.bounds, axisLines);
                const calculated = calculateMergeVector(baseIntersections, targetIntersections);
                if (calculated) vec = calculated;
            }

            // Record Mapping
            mappings.push({
                sourceRegionIndex: regions.indexOf(view),
                targetRegionIndex: regions.indexOf(baseView),
                vector: vec,
                bounds: view.bounds,
                // Use parsed prefix if available (removes (1), (2), etc.)
                title: view.info ? view.info.prefix : view.title
            });

            // Extract & Shift Entities
            const expandedBounds = expandBounds(view.bounds, 2000);
            
            // Optimization: Filter allEntities for this view first
            const viewEntities = allEntities.filter(e => {
                 const b = getEntityBounds(e);
                 if (!b) return false;
                 return boundsOverlap(b, expandedBounds);
            });

            // Group by layer to detect orientation
            const layerGroups: Record<string, DxfEntity[]> = {};
            viewEntities.forEach(e => {
                if (isLabelLayer(e.layer)) {
                    if (!layerGroups[e.layer]) layerGroups[e.layer] = [];
                    layerGroups[e.layer].push(e);
                }
            });

            Object.entries(layerGroups).forEach(([layer, ents]) => {
                const orientation = detectOrientation(layer, ents);
                const targetLayer = orientation === 'H' ? RESULT_LAYER_H : RESULT_LAYER_V;
                
                ents.forEach(ent => {
                    // Shift
                    const clone = { ...ent };
                    if (clone.start) clone.start = { x: clone.start.x + vec.x, y: clone.start.y + vec.y };
                    if (clone.end) clone.end = { x: clone.end.x + vec.x, y: clone.end.y + vec.y };
                    if (clone.center) clone.center = { x: clone.center.x + vec.x, y: clone.center.y + vec.y };
                    if (clone.vertices) clone.vertices = clone.vertices.map(v => ({ x: v.x + vec.x, y: v.y + vec.y }));
                    
                    if (clone.type === EntityType.DIMENSION) {
                        if (clone.measureStart) clone.measureStart = { x: clone.measureStart.x + vec.x, y: clone.measureStart.y + vec.y };
                        if (clone.measureEnd) clone.measureEnd = { x: clone.measureEnd.x + vec.x, y: clone.measureEnd.y + vec.y };
                    }
                    
                    tempMergedEntities.push({ layer: targetLayer, ent: clone });
                });
            });
        });
    });

    // Parse Beam Labels from Merged Entities
    const beamLabels: BeamLabelInfo[] = [];
    const extras: DxfEntity[] = [];

    tempMergedEntities.forEach(item => {
        // Separate Text from Geometry (Leaders)
        if (item.ent.type === EntityType.TEXT || item.ent.type === EntityType.ATTRIB) {
             const txt = item.ent;
             if (!txt.start) return;
             
             // Use original rotation/orientation from the entity
             const orientation = txt.rotation ?? txt.startAngle ?? 0;

             // Parse Text
             const rawText = (txt.text || '').trim();
             const firstLine = rawText.split('\n')[0].trim();
             
             // Basic Parsing: "KL-1(2)" or "WKL1"
             const richMatch = firstLine.match(/^([A-Z0-9\-]+)(?:\((.+)\))?/);
             let parsed = undefined;

             if (richMatch) {
                 const code = richMatch[1];
                 const span = richMatch[2] || null;

                 // Search for dimensions in any line
                 let width = 0;
                 let height = 0;
                 
                 const dimMatch = rawText.match(/(\d+)[xX*×](\d+)/);
                 if (dimMatch) {
                     width = parseInt(dimMatch[1], 10);
                     height = parseInt(dimMatch[2], 10);
                 }

                 parsed = { code, span, width, height };
             }

             beamLabels.push({
                 id: `LBL-${beamLabels.length}`,
                 sourceLayer: item.layer,
                 orientation: orientation,
                 textRaw: rawText,
                 textInsert: txt.start,
                 leaderStart: null, // Leaders removed as per request
                 leaderEnd: null,
                 parsed
             });
        } else {
             // Keep geometry (leaders) in extras
             extras.push({
                 ...item.ent,
                 layer: item.layer
             });
        }
    });

    return { mappings, beamLabels, extras };
};

// --- 2. RENDERING LOGIC ---

export const generateMergedViewEntities = (data: MergedViewData): DxfEntity[] => {
    const entities: DxfEntity[] = [];

    // 1. Draw MERGE_VIEW frames
    // We only need to draw the bounds of the "Base View" for each group
    // In our mappings, multiple sources map to one target.
    // We can just draw the Target Region (Base View) bounds once per group.
    
    const processedTargets = new Set<number>();

    data.mappings.forEach(m => {
         if (processedTargets.has(m.targetRegionIndex)) return;
         processedTargets.add(m.targetRegionIndex);
         
         const b = m.bounds; // Source Bounds
         // Reconstruct Destination Bounds
         const destMinX = b.minX + m.vector.x;
         const destMinY = b.minY + m.vector.y;
         const destMaxX = b.maxX + m.vector.x;
         const destMaxY = b.maxY + m.vector.y;

         entities.push({
            type: EntityType.LWPOLYLINE,
            layer: RESULT_LAYER_VIEW,
            closed: true,
            vertices: [
                {x: destMinX, y: destMinY},
                {x: destMaxX, y: destMinY},
                {x: destMaxX, y: destMaxY},
                {x: destMinX, y: destMaxY}
            ]
         });

         // Draw Title
         const title = m.title || "Merged View";
         entities.push({
             type: EntityType.TEXT,
             layer: RESULT_LAYER_VIEW,
             text: title,
             start: {x: destMinX, y: destMaxY + 200},
             radius: 350
         });
    });

    // 2. Draw Labels
    data.beamLabels.forEach(lbl => {
        if (!lbl.textInsert) return;
        entities.push({
            type: EntityType.TEXT,
            layer: lbl.sourceLayer, // MERGE_LABEL_H or V
            text: lbl.textRaw,
            start: lbl.textInsert,
            radius: 250,
            startAngle: lbl.orientation
        });
    });

    // 3. Draw Extras (Leaders)
    if (data.extras) {
        entities.push(...data.extras);
    }

    return entities;
};

// --- 3. ORCHESTRATION ---

export const restoreMergedViews = (
    activeProject: ProjectFile,
    data: MergedViewData,
    setProjects: React.Dispatch<React.SetStateAction<ProjectFile[]>>,
    setLayerColors: React.Dispatch<React.SetStateAction<Record<string, string>>>
) => {
    console.log("Restoring Merged View Analysis...");
    const entities = generateMergedViewEntities(data);
    
    // Update Colors
    setLayerColors(prev => ({ ...prev, ...RESULT_COLORS }));

    // Update Project
    updateProject(
        activeProject, 
        setProjects, 
        setLayerColors, 
        RESULT_LAYER_VIEW, 
        entities, 
        RESULT_COLORS[RESULT_LAYER_VIEW], 
        [RESULT_LAYER_H, RESULT_LAYER_V], 
        false
    );

    setProjects(prev => prev.map(p => {
        if (p.id === activeProject.id) {
            return { ...p, mergedViewData: data };
        }
        return p;
    }));
};

export const runMergeViews = (
    activeProject: ProjectFile,
    setProjects: React.Dispatch<React.SetStateAction<ProjectFile[]>>,
    setLayerColors: React.Dispatch<React.SetStateAction<Record<string, string>>>
) => {
    const data = calculateMergedViewData(activeProject);
    if (!data) {
        alert("Could not merge views. Ensure views are split and axes are configured.");
        return;
    }

    saveStoredAnalysis(activeProject.name, { mergedViewData: data });
    restoreMergedViews(activeProject, data, setProjects, setLayerColors);
};
