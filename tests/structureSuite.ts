import { parseDxf } from "../utils/dxfParser";
import { ProjectFile, DxfData } from "../types";
import { generateMockDxfContent } from "./mockDxf";
import { runCalculateSplitRegions, runMergeViews } from "../domains/structure-views";
import { runCalculateColumns, runCalculateWalls } from "../domains/structure-verticals";

/**
 * Runs a sequence of structure analysis tests using synthetic data.
 * No UI interaction required.
 */
export const runStructureTests = async () => {
    console.log("%c🚀 STARTING STRUCTURE INTEGRATION TESTS", "color: #3b82f6; font-weight: bold; font-size: 12px;");
    
    const logs: string[] = [];
    const log = (msg: string, success: boolean = true) => {
        const icon = success ? '✅' : '❌';
        console.log(`${icon} ${msg}`);
        logs.push(`${icon} ${msg}`);
    };

    try {
        // --- STEP 0: SETUP ---
        const mockDxfContent = generateMockDxfContent();
        const parsedData = parseDxf(mockDxfContent);
        
        let projects: ProjectFile[] = [{
            id: 'test-project-001',
            name: 'MOCK_STRUCTURE_TEST.dxf',
            data: parsedData,
            activeLayers: new Set(parsedData.layers),
            filledLayers: new Set(),
            splitRegions: null
        }];

        let layerColors: Record<string, string> = {};
        parsedData.layers.forEach(l => layerColors[l] = '#ffffff');

        // Mock State Setters
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
        console.log("... Running Split Views");
        const regions = runCalculateSplitRegions(getActive(), setProjects, setLayerColors, true);
        
        if (!regions || regions.length === 0) throw new Error("Split Regions failed to return regions.");
        if (!getActive().splitRegions || getActive().splitRegions!.length === 0) throw new Error("Project state not updated with splitRegions.");
        
        log(`Step 1 (Split Views): Passed. Found ${regions.length} region(s).`);


        // --- STEP 2: MERGE VIEWS ---
        // (Even with 1 region, it processes labels, we just check no crash and state update capability)
        console.log("... Running Merge Views");
        runMergeViews(getActive(), setProjects, setLayerColors);
        // Note: Mock data might not trigger a merge if there's only 1 view or no matching merge labels, 
        // but checking the function runs without error is the baseline.
        // We can check if MERGE_LABEL was added to layers list if it found anything, but it's optional.
        log(`Step 2 (Merge Views): Passed (Execution successful).`);


        // --- STEP 3: COLUMNS ---
        console.log("... Running Columns");
        runCalculateColumns(getActive(), projects, setProjects, setLayerColors);
        
        const pCol = getActive();
        if (!pCol.data.layers.includes('COLU_CALC')) throw new Error("COLU_CALC layer was not created.");
        const colCount = pCol.data.entities.filter(e => e.layer === 'COLU_CALC').length;
        if (colCount === 0) throw new Error("No Column entities generated.");
        
        log(`Step 3 (Columns): Passed. Generated ${colCount} columns.`);


        // --- STEP 4: WALLS ---
        console.log("... Running Walls");
        runCalculateWalls(getActive(), projects, setProjects, setLayerColors);
        
        const pWall = getActive();
        if (!pWall.data.layers.includes('WALL_CALC')) throw new Error("WALL_CALC layer was not created.");
        const wallCount = pWall.data.entities.filter(e => e.layer === 'WALL_CALC').length;
        if (wallCount === 0) throw new Error("No Wall entities generated.");

        log(`Step 4 (Walls): Passed. Generated ${wallCount} wall segments.`);

        // --- CONCLUSION ---
        console.log("%c🎉 ALL TESTS PASSED", "color: #10b981; font-weight: bold;");
        alert(`INTEGRATION TESTS PASSED\n--------------------------\n${logs.join('\n')}`);

    } catch (e: any) {
        console.error(e);
        log(`TEST FAILED: ${e.message}`, false);
        alert(`TEST FAILED\n--------------------------\n${e.message}`);
    }
};