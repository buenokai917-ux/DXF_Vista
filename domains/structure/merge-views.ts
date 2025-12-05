
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
const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

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
    const isLabelLayer = (layer: string) => {
        // Strict config check
        if (activeProject.layerConfig[SemanticLayer.BEAM_LABEL].includes(layer)) return true;
        
        // Heuristics
        const u = layer.toUpperCase();
        if (u.includes('AXIS') || u.includes('中心线')) return false;
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
                title: view.title
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
    const entitiesByResultLayer: Record<string, DxfEntity[]> = { [RESULT_LAYER_H]: [], [RESULT_LAYER_V]: [] };
    
    tempMergedEntities.forEach(item => {
        if (entitiesByResultLayer[item.layer]) entitiesByResultLayer[item.layer].push(item.ent);
    });

    [RESULT_LAYER_H, RESULT_LAYER_V].forEach(layer => {
        const ents = entitiesByResultLayer[layer];
        const texts = ents.filter(e => (e.type === EntityType.TEXT || e.type === EntityType.ATTRIB) && e.start);
        const leaders = ents.filter(e => e.type === EntityType.LINE || e.type === EntityType.LWPOLYLINE);

        texts.forEach((txt, idx) => {
             if (!txt.start) return;
             const rot = txt.rotation ?? txt.startAngle ?? 0;
             const isVert = isVerticalAngle(rot);
             const basePoint = (isVert && txt.end) ? txt.end : txt.start!;

             // Find Leader
             let bestSeg: { start: Point, end: Point } | null = null;
             let bestDist = Infinity;

             const checkSeg = (p1: Point, p2: Point) => {
                 const d = distancePointToLine(basePoint, p1, p2);
                 if (d < bestDist) { bestDist = d; bestSeg = { start: p1, end: p2 }; }
             };

             leaders.forEach(l => {
                 if (l.type === EntityType.LINE && l.start && l.end) checkSeg(l.start, l.end);
                 else if (l.type === EntityType.LWPOLYLINE && l.vertices) {
                     for (let i=0; i<l.vertices.length-1; i++) checkSeg(l.vertices[i], l.vertices[i+1]);
                 }
             });

             if (bestDist > 1200 || !bestSeg) return; // No leader found close enough

             let lStart = bestSeg.start;
             let lEnd = bestSeg.end;
             if (dist(basePoint, lEnd) < dist(basePoint, lStart)) {
                 lStart = bestSeg.end; lEnd = bestSeg.start;
             }
             
             const orientation = Math.atan2(lEnd.y - lStart.y, lEnd.x - lStart.x) * 180 / Math.PI;

             // Parse Text
             const rawText = (txt.text || '').trim();
             const firstLine = rawText.split('\n')[0].trim();
             
             const richMatch = firstLine.match(/^([A-Z0-9\-]+)\(([^)]+)\)\s+(\d+)[xX*](\d+)/i);
             const simpleDimMatch = firstLine.match(/^([A-Z0-9\-]+)\s+(\d+)[xX*](\d+)/i);
             const codeSpanMatch = firstLine.match(/^([A-Z0-9\-]+)\(([^)]+)\)/i);
             const codeOnlyMatch = firstLine.match(/^([A-Z0-9\-]+)$/i);

             let parsed: any = undefined;
             if (richMatch) parsed = { code: richMatch[1], span: richMatch[2], width: parseInt(richMatch[3]), height: parseInt(richMatch[4]) };
             else if (simpleDimMatch) parsed = { code: simpleDimMatch[1], span: null, width: parseInt(simpleDimMatch[2]), height: parseInt(simpleDimMatch[3]) };
             else if (codeSpanMatch) parsed = { code: codeSpanMatch[1], span: codeSpanMatch[2] };
             else if (codeOnlyMatch) parsed = { code: codeOnlyMatch[1], span: null };

             beamLabels.push({
                 id: `${layer}-${idx}`,
                 sourceLayer: layer,
                 orientation,
                 textRaw: rawText,
                 textInsert: txt.start,
                 leaderStart: lStart,
                 leaderEnd: lEnd,
                 parsed
             });
        });
    });

    // Fill missing dims logic
    const byCode = new Map<string, {width: number, height: number}>();
    beamLabels.forEach(l => {
        if (l.parsed && l.parsed.width && l.parsed.height) byCode.set(l.parsed.code, { width: l.parsed.width, height: l.parsed.height });
    });
    beamLabels.forEach(l => {
        if (l.parsed && (!l.parsed.width || !l.parsed.height)) {
            const donor = byCode.get(l.parsed.code);
            if (donor) { l.parsed.width = donor.width; l.parsed.height = donor.height; }
        }
    });

    return {
        mappings,
        beamLabels
    };
};

// --- 2. RENDERING LOGIC ---

export const generateMergedViewEntities = (data: MergedViewData): { entities: DxfEntity[], layers: string[] } => {
    const entities: DxfEntity[] = [];

    // 1. Draw Labels (Text + Leaders)
    data.beamLabels.forEach(lbl => {
        const layer = lbl.sourceLayer; // H or V
        
        // Text
        if (lbl.textInsert) {
            entities.push({
                type: EntityType.TEXT,
                layer,
                text: lbl.textRaw,
                start: lbl.textInsert,
                radius: 250, // Standardize size
                startAngle: layer === RESULT_LAYER_V ? 90 : 0
            });
        }

        // Leader
        if (lbl.leaderStart && lbl.leaderEnd) {
            entities.push({
                type: EntityType.LINE,
                layer,
                start: lbl.leaderStart,
                end: lbl.leaderEnd
            });
            // Arrowhead (Circle for simplicity)
            entities.push({
                type: EntityType.CIRCLE,
                layer,
                center: lbl.leaderEnd,
                radius: 40
            });
        }
    });

    // 2. Draw Mappings (Base Regions in Yellow)
    // Identify unique target regions (Base Views) and draw them
    
    data.mappings.forEach(m => {
        const shiftedMinX = m.bounds.minX + m.vector.x;
        const shiftedMinY = m.bounds.minY + m.vector.y;
        const shiftedMaxX = m.bounds.maxX + m.vector.x;
        const shiftedMaxY = m.bounds.maxY + m.vector.y;

        // Draw Boundary Box
        entities.push({
            type: EntityType.LWPOLYLINE,
            layer: RESULT_LAYER_VIEW,
            closed: true,
            vertices: [
                { x: shiftedMinX, y: shiftedMinY },
                { x: shiftedMaxX, y: shiftedMinY },
                { x: shiftedMaxX, y: shiftedMaxY },
                { x: shiftedMinX, y: shiftedMaxY }
            ]
        });

        // Draw Title
        if (m.title) {
            entities.push({
                type: EntityType.TEXT,
                layer: RESULT_LAYER_VIEW,
                text: m.title,
                start: { x: shiftedMinX, y: shiftedMaxY + 500 },
                radius: 250
            });
        }
    });

    return {
        entities,
        layers: [RESULT_LAYER_H, RESULT_LAYER_V, RESULT_LAYER_VIEW]
    };
};

// --- 3. ORCHESTRATION ---

export const restoreMergedViews = (
    activeProject: ProjectFile,
    data: MergedViewData,
    setProjects: React.Dispatch<React.SetStateAction<ProjectFile[]>>,
    setLayerColors: React.Dispatch<React.SetStateAction<Record<string, string>>>
) => {
    console.log("Restoring Merged Views...");
    const { entities, layers } = generateMergedViewEntities(data);
    
    setLayerColors(prev => ({ ...prev, ...RESULT_COLORS }));

    setProjects(prev => prev.map(p => {
        if (p.id === activeProject.id) {
            const updatedData = {
                ...p.data,
                entities: [...p.data.entities, ...entities],
                layers: Array.from(new Set([...p.data.layers, ...layers]))
            };
            const activeLayers = new Set(p.activeLayers);
            layers.forEach(l => activeLayers.add(l));

            return {
                ...p,
                data: updatedData,
                activeLayers,
                mergedViewData: data,
                beamLabels: data.beamLabels
            };
        }
        return p;
    }));
};

export const runMergeViews = (
    activeProject: ProjectFile,
    setProjects: React.Dispatch<React.SetStateAction<ProjectFile[]>>,
    setLayerColors: React.Dispatch<React.SetStateAction<Record<string, string>>>
) => {
    // 1. Calculate
    const mergedData = calculateMergedViewData(activeProject);
    if (!mergedData) {
        alert("Could not merge views. Ensure Split Views is run first.");
        return;
    }

    // 2. Save
    saveStoredAnalysis(activeProject.name, { mergedViewData: mergedData });

    // 3. Render
    const { entities, layers } = generateMergedViewEntities(mergedData);

    // 4. Update UI
    setLayerColors(prev => ({ ...prev, ...RESULT_COLORS }));
    setProjects(prev => prev.map(p => {
        if (p.id === activeProject.id) {
            const updatedData = {
                ...p.data,
                entities: [...p.data.entities, ...entities],
                layers: Array.from(new Set([...p.data.layers, ...layers]))
            };
            const activeLayers = new Set(p.activeLayers);
            layers.forEach(l => activeLayers.add(l));

            return {
                ...p,
                data: updatedData,
                activeLayers,
                mergedViewData: mergedData,
                beamLabels: mergedData.beamLabels
            };
        }
        return p;
    }));
    
    console.log(`Merged Views Complete. Found ${mergedData.beamLabels.length} labels.`);
};
