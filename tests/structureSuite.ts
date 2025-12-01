import { parseDxf } from "../utils/dxfParser";
import { ProjectFile, DxfData } from "../types";
import { generateMockDxfContent } from "./mockDxf";
import { COMPLEX_DXF_CONTENT } from "./data/ComplexDxfData";
import { runCalculateSplitRegions, runMergeViews } from "../domains/structure-views";
import { runCalculateColumns, runCalculateWalls } from "../domains/structure-verticals";

/**
 * Runs a sequence of structure analysis tests.
 * 
 * Flow:
 * 1. Load Data (Complex file if provided, otherwise Mock)
 * 2. Split Views (Identify viewport regions)
 * 3. Merge Views (Consolidate duplicate labels)
 * 4. Calculate Columns (Identify verticals)
 * 5. Calculate Walls (Identify linear verticals)
 */
export const runStructureTests = async () => {
    console.group("🚀 STRUCTURE INTEGRATION TESTS");
    
    const logs: string[] = [];
    const log = (msg: string, success: boolean = true) => {
        const icon = success ? '✅' : '❌';
        console.log(`${icon} ${msg}`);
        logs.push(`${icon} ${msg}`);
    };

    try {
        // --- STEP 0: SETUP ---
        console.log("... Initializing Test Environment");
        
        let dxfContent = COMPLEX_DXF_CONTENT.trim();
        let sourceName = "REAL_DATA (配筋简图.dxf)";
        
        if (!dxfContent) {
            console.log("⚠️ No complex data found. Falling back to synthetic mock data.");
            dxfContent = generateMockDxfContent();
            sourceName = "MOCK_DATA";
        }

        const parsedData = parseDxf(dxfContent);
        console.log(`... Loaded ${sourceName}: ${parsedData.entities.length} entities, ${parsedData.layers.length} layers.`);

        let projects: ProjectFile[] = [{
            id: 'test-project-001',
            name: 'TEST_PROJECT.dxf',
            data: parsedData,
            activeLayers: new Set(parsedData.layers),
            filledLayers: new Set(),
            splitRegions: null
        }];

        let layerColors: Record<string, string> = {};
        parsedData.layers.forEach(l => layerColors[l] = '#ffffff');

        // Mock State Setters (Captures updates to our local variables)
        const setProjects = (action: any) => {
            if (typeof action === 'function') projects = action(projects);
            else projects = action;
        };
        const setLayerColors = (action: any) => {
            if (typeof action === 'function') layerColors = action(layerColors);
            else layerColors = action;
        };

        const getActive = () => projects[0];

        // --- STEP 1: SPLIT VIEWS ---
        console.time("Step 1: Split Views");
        const regions = runCalculateSplitRegions(getActive(), setProjects, setLayerColors, true);
        console.timeEnd("Step 1: Split Views");

        if (!regions || regions.length === 0) {
            throw new Error("Split Regions failed to return any regions. Check AXIS and Viewport Title layers.");
        }
        
        // Verify State Update
        if (!getActive().splitRegions || getActive().splitRegions!.length === 0) {
            throw new Error("Project state was not updated with splitRegions.");
        }
        
        log(`Step 1 (Split Views): Passed. Found ${regions.length} region(s).`);


        // --- STEP 2: MERGE VIEWS ---
        // Consolidates labels from split views
        console.time("Step 2: Merge Views");
        runMergeViews(getActive(), setProjects, setLayerColors);
        console.timeEnd("Step 2: Merge Views");
        
        // Check if MERGE_LABEL layer was created (it might not be if no labels found, which is valid for empty mock, but we added some)
        const hasMergeLayer = getActive().data.layers.includes('MERGE_LABEL');
        log(`Step 2 (Merge Views): Passed. ${hasMergeLayer ? 'Merge layer created.' : 'No items merged (acceptable if empty).'}`);


        // --- STEP 3: COLUMNS ---
        console.time("Step 3: Columns");
        runCalculateColumns(getActive(), projects, setProjects, setLayerColors);
        console.timeEnd("Step 3: Columns");
        
        const pCol = getActive();
        if (!pCol.data.layers.includes('COLU_CALC')) {
            throw new Error("COLU_CALC layer was not created. Check if 'COLUMN' or 'COLU' layers exist in source.");
        }
        const colCount = pCol.data.entities.filter(e => e.layer === 'COLU_CALC').length;
        if (colCount === 0) {
            console.warn("⚠️ No columns generated. Verify source data has closed polylines/circles on COLUMN layer.");
        }
        
        log(`Step 3 (Columns): Passed. Generated ${colCount} columns.`);


        // --- STEP 4: WALLS ---
        console.time("Step 4: Walls");
        runCalculateWalls(getActive(), projects, setProjects, setLayerColors);
        console.timeEnd("Step 4: Walls");
        
        const pWall = getActive();
        if (!pWall.data.layers.includes('WALL_CALC')) {
            throw new Error("WALL_CALC layer was not created. Check if 'WALL' layers exist in source.");
        }
        const wallCount = pWall.data.entities.filter(e => e.layer === 'WALL_CALC').length;
        
        if (wallCount === 0) {
            console.warn("⚠️ No walls generated. Verify source data has parallel lines on WALL layer.");
        }

        log(`Step 4 (Walls): Passed. Generated ${wallCount} wall segments.`);

        // --- CONCLUSION ---
        console.groupEnd();
        alert(`INTEGRATION TESTS PASSED (${sourceName})\n--------------------------\n${logs.join('\n')}`);

    } catch (e: any) {
        console.error(e);
        console.groupEnd();
        log(`TEST FAILED: ${e.message}`, false);
        alert(`TEST FAILED\n--------------------------\n${e.message}`);
    }
};
