// src/hooks/gameHooks.ts
import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
    getFriendlyDate,
    getFormattedDate,
    getDataFilePath,
    findLongestWordChain,
    areAdjacent,
    findWordCoordinates,
    CellCoordinates,
    GameData,
    HistoryEntry,
    ExplorationNodeData,
    DifficultyLevel,
} from '../utils/gameHelpers';
import { GameLogic, CoreGameState } from '../core/gameLogic';
import * as storage from '../core/storage'; // Import the new storage module
import type { LevelCompletionSummary } from '../core/storage'; // Import types from storage

export const difficulties: DifficultyLevel[] = ['normal', 'hard', 'impossible'];

// Kept LevelResultData here as it's more of a UI transformation of LevelCompletionSummary
export interface LevelResultData {
    history: HistoryEntry[];
    score: number;
    maxScore: number;
    optimalPathWords: string[];
    levelCompleted: boolean;
}

export const gameHooks = () => {
    // --- UI and App State ---
    const [darkMode, setDarkMode] = useState(() => {
        const preference = storage.loadDarkModePreference();
        if (preference !== undefined) return preference;
        if (typeof window !== 'undefined') {
            return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
        }
        return false;
    });
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [currentDate, setCurrentDate] = useState<Date>();
    const [difficulty, setDifficulty] = useState<DifficultyLevel>('normal');
    const [dailyProgress, setDailyProgress] = useState<Record<DifficultyLevel, boolean>>({ normal: false, hard: false, impossible: false });
    const [isDebugMode, setIsDebugMode] = useState(false);
    const [reloadTrigger, setReloadTrigger] = useState(0);

    // --- Core Game Logic Instance ---
    const gameLogicRef = useRef<GameLogic>(new GameLogic());

    // --- React State reflecting Core Game Logic ---
    const [grid, setGrid] = useState<string[][]>([[]]);
    const [currentPossibleMoves, setCurrentPossibleMoves] = useState<ExplorationNodeData[]>([]);
    const [currentDepth, setCurrentDepth] = useState<number>(0);
    const [history, setHistory] = useState<HistoryEntry[]>([]);
    const [hasDeviated, setHasDeviated] = useState<boolean>(false);
    const [turnFailedAttempts, setTurnFailedAttempts] = useState<number>(0);
    const [isCoreGameOver, setIsCoreGameOver] = useState<boolean>(false);
    const [coreGameData, setCoreGameData] = useState<GameData | null>(null);

    // --- UI Interaction State ---
    const [selectedCell, setSelectedCell] = useState<CellCoordinates | null>(null);
    const [draggedCell, setDraggedCell] = useState<CellCoordinates | null>(null);
    const [hoveredCell, setHoveredCell] = useState<CellCoordinates | null>(null);
    const [isInvalidMove, setIsInvalidMove] = useState<boolean>(false);
    const [invalidMoveMessage, setInvalidMoveMessage] = useState<string>('');

    // --- Animation & Feedback State ---
    const [animationState, setAnimationState] = useState<{ animating: boolean, from: CellCoordinates | null, to: CellCoordinates | null }>({ animating: false, from: null, to: null });
    const animationTimeoutRef = useRef<number | null>(null);
    const [highlightedCells, setHighlightedCells] = useState<CellCoordinates[]>([]);
    const highlightTimeoutRef = useRef<number | null>(null);
    const [wiggleCells, setWiggleCells] = useState<CellCoordinates[]>([]);
    const wiggleTimeoutRef = useRef<number | null>(null);
    const [hintCells, setHintCells] = useState<CellCoordinates[]>([]);
    const hintTimeoutRef = useRef<number | null>(null);

    // --- Game Over Flow & Summary State ---
    const [isDisplayGameOver, setIsDisplayGameOver] = useState<boolean>(false);
    const [hasAcknowledgedGameOver, setHasAcknowledgedGameOver] = useState<boolean>(false);
    const [showEndGamePanelOverride, setShowEndGamePanelOverride] = useState<boolean>(false);
    const [combinedSummaryData, setCombinedSummaryData] = useState<Partial<Record<DifficultyLevel, LevelCompletionSummary | null>>>({});

    const updateReactStateFromCore = useCallback((coreState: CoreGameState | null) => {
        if (coreState) {
            setGrid(coreState.grid);
            setCurrentPossibleMoves(coreState.currentPossibleMoves);
            setCurrentDepth(coreState.currentDepth);
            setHistory(coreState.history);
            setHasDeviated(coreState.hasDeviated);
            setTurnFailedAttempts(coreState.turnFailedAttempts);
            setIsCoreGameOver(coreState.isGameOver);
            setCoreGameData(coreState.gameData);
        } else {
            setGrid([[]]);
            setCurrentPossibleMoves([]);
            setCurrentDepth(0);
            setHistory([]);
            setHasDeviated(false);
            setTurnFailedAttempts(0);
            setIsCoreGameOver(false);
            setCoreGameData(null);
        }
    }, []);

    const liveOptimalPathWords = useMemo(() => {
        if (coreGameData) {
            return findLongestWordChain(coreGameData.explorationTree, history);
        }
        return [];
    }, [coreGameData, history]);

    const livePlayerUniqueWordsFound = useMemo(() => {
        const words = new Set<string>();
        history.forEach(state => { if (Array.isArray(state.wordsFormedByMove)) { state.wordsFormedByMove.forEach(word => words.add(word)); } });
        return words;
    }, [history]);

    const liveMaxDepthAttainable = useMemo(() => coreGameData?.maxDepthReached || 0, [coreGameData]);
    const wordLength = useMemo(() => coreGameData?.wordLength || 4, [coreGameData]);

    const triggerWiggle = useCallback((cell1: CellCoordinates, cell2: CellCoordinates) => {
        if (wiggleTimeoutRef.current) clearTimeout(wiggleTimeoutRef.current);
        setWiggleCells([cell1, cell2]);
        wiggleTimeoutRef.current = window.setTimeout(() => {
            setWiggleCells([]);
            wiggleTimeoutRef.current = null;
        }, 500);
    }, []);

    useEffect(() => {
        if (darkMode) {
            document.documentElement.classList.add('dark');
        } else {
            document.documentElement.classList.remove('dark');
        }
        storage.saveDarkModePreference(darkMode);
    }, [darkMode]);

    useEffect(() => {
        try {
            const today = new Date();
            setCurrentDate(today);
            const params = new URLSearchParams(window.location.search);
            setIsDebugMode(params.get('debug') === 'true');
            const urlDifficulty = params.get('difficulty') as DifficultyLevel | null;

            const currentDailyProgressState = storage.loadDifficultyCompletionStatus(today, difficulties);
            setDailyProgress(currentDailyProgressState);

            let initialDifficultyValue: DifficultyLevel = 'normal';
            if (urlDifficulty && difficulties.includes(urlDifficulty)) {
                initialDifficultyValue = urlDifficulty;
            } else if (currentDailyProgressState.normal && !currentDailyProgressState.hard) {
                initialDifficultyValue = 'hard';
            } else if (currentDailyProgressState.normal && currentDailyProgressState.hard && !currentDailyProgressState.impossible) {
                initialDifficultyValue = 'impossible';
            }
            setDifficulty(initialDifficultyValue);
        } catch (e) {
            console.error("Error in initial date/difficulty/progress load useEffect:", e);
            setError("Failed to initialize game settings. Please refresh.");
        }
    }, []); // Removed dependencies that might cause re-runs if storage functions are not memoized by caller

    const masterResetGameStates = useCallback(() => {
        try {
            if (animationTimeoutRef.current) clearTimeout(animationTimeoutRef.current);
            if (highlightTimeoutRef.current) clearTimeout(highlightTimeoutRef.current);
            if (wiggleTimeoutRef.current) clearTimeout(wiggleTimeoutRef.current);
            if (hintTimeoutRef.current) clearTimeout(hintTimeoutRef.current);
            updateReactStateFromCore(null);
            setIsInvalidMove(false);
            setInvalidMoveMessage('');
            setSelectedCell(null);
            setHoveredCell(null);
            setDraggedCell(null);
            setWiggleCells([]);
            setHintCells([]);
            setAnimationState({ animating: false, from: null, to: null });
            setIsDisplayGameOver(false);
            setHasAcknowledgedGameOver(false);
            setShowEndGamePanelOverride(false);
            setCombinedSummaryData({});
            setReloadTrigger(prev => prev + 1);
        } catch (e) {
            console.error("Error in masterResetGameStates:", e);
            setError("Failed to reset game state. Please refresh.");
        }
    }, [updateReactStateFromCore]);

    useEffect(() => {
        const loadLevelDataInternal = async (date: Date, diff: DifficultyLevel) => {
            console.log(`[loadLevelDataInternal] Starting for difficulty: ${diff}, date: ${getFormattedDate(date)}`);
            if (!date) {
                setError("Date not available for loading level.");
                setLoading(false);
                return;
            }
            setLoading(true);
            setError(null);
            updateReactStateFromCore(null);
            setIsInvalidMove(false);setInvalidMoveMessage('');setSelectedCell(null);setHoveredCell(null);setDraggedCell(null);
            setWiggleCells([]);setHintCells([]);setAnimationState({ animating: false, from: null, to: null });
            setIsDisplayGameOver(false);setHasAcknowledgedGameOver(false);setShowEndGamePanelOverride(false);

            try {
                const basePath = '';
                const response = await fetch(`${basePath}/levels/${diff}/${getDataFilePath(date)}`);
                if (!response.ok) {
                    if (response.status === 404) throw new Error(`Today's ${diff} level is not available yet. Please check back later!`);
                    throw new Error(`Failed to fetch ${diff} level for ${getFormattedDate(date)} (HTTP ${response.status})`);
                }
                const fetchedGameData: GameData = await response.json();
                if (!fetchedGameData || !fetchedGameData.initialGrid || !Array.isArray(fetchedGameData.initialGrid)) {
                    throw new Error(`Level data for ${diff} is corrupted.`);
                }

                const fetchedGameDataString = JSON.stringify(fetchedGameData);
                const currentJsonFileHash = storage.simpleHash(fetchedGameDataString);
                
                const savedProgressForLevel = storage.loadInProgressState(date, diff, currentJsonFileHash);
                
                const initialCoreStateLoaded = gameLogicRef.current.loadLevel(fetchedGameData, savedProgressForLevel);
                updateReactStateFromCore(initialCoreStateLoaded); 

                let finalCoreStateForThisLoad = initialCoreStateLoaded;
                let shouldBeInitiallyGameOver = finalCoreStateForThisLoad.isGameOver;
                let shouldAcknowledge = false;

                const dailyProgressDataStore = storage.loadDailyProgress(date);
                const isDailyCompleted = dailyProgressDataStore[diff]?.completed || false;

                if (isDailyCompleted) {
                    const isLoadingInProgressNonResetState = savedProgressForLevel && (savedProgressForLevel.currentDepth > 0 || savedProgressForLevel.history.length > 0);
                    
                    if (isLoadingInProgressNonResetState || finalCoreStateForThisLoad.isGameOver) {
                        if (!finalCoreStateForThisLoad.isGameOver) { 
                            gameLogicRef.current.forceGameOver();
                            finalCoreStateForThisLoad = gameLogicRef.current.getCurrentGameState(); 
                            updateReactStateFromCore(finalCoreStateForThisLoad); 
                        }
                        shouldBeInitiallyGameOver = true; 
                        shouldAcknowledge = true; 
                    } else {
                        shouldBeInitiallyGameOver = false; 
                    }
                }

                if (shouldBeInitiallyGameOver) {
                    setIsDisplayGameOver(true);
                    setHasAcknowledgedGameOver(shouldAcknowledge);
                } else {
                    setIsDisplayGameOver(false);
                    setHasAcknowledgedGameOver(false);
                }

            } catch (err: any) {
                console.error(`[loadLevelDataInternal] Error loading level data for ${diff}:`, err);
                setError(err.message || `Failed to load ${diff} level.`);
                updateReactStateFromCore(null); 
                setIsDisplayGameOver(false);
                setHasAcknowledgedGameOver(false);
            } finally {
                setLoading(false);
                console.log(`[loadLevelDataInternal] Finished for difficulty: ${diff}. Loading state: false.`);
            }
        };

        if (currentDate && difficulty) {
            loadLevelDataInternal(currentDate, difficulty);
        } else {
            if (!currentDate) console.warn("[loadLevelDataInternal] Skipped: currentDate not set.");
            if (!difficulty) console.warn("[loadLevelDataInternal] Skipped: difficulty not set.");
            setLoading(false); 
        }
     
    }, [currentDate, difficulty, reloadTrigger, updateReactStateFromCore]);

    useEffect(() => {
        if (!loading && !error && coreGameData && currentDate && difficulty && grid.length > 0 && grid[0].length > 0) {
            const gameStateToSave = gameLogicRef.current.getGameStateForSaving();
            if (gameStateToSave) {
                try {
                    const jsonForHashing = JSON.stringify(coreGameData);
                    const currentJsonFileHash = storage.simpleHash(jsonForHashing);
                    storage.saveInProgressState(currentDate, difficulty, gameStateToSave, currentJsonFileHash);
                } catch (e) { console.error("Failed to save game state (hook):", e); }
            }
        }
    }, [grid, history, currentDepth, turnFailedAttempts, hasDeviated, currentDate, difficulty, coreGameData, loading, error]);

    useEffect(() => {
        if (showEndGamePanelOverride || loading || !coreGameData || animationState.animating || error) {
            return;
        }
        if (isCoreGameOver) {
            if (!isDisplayGameOver) {
                setIsDisplayGameOver(true); 
                setHasAcknowledgedGameOver(false); 
            }
        } else {
            if (isDisplayGameOver) {
                setIsDisplayGameOver(false); 
                setHasAcknowledgedGameOver(false);
            }
        }
    }, [coreGameData, animationState.animating, showEndGamePanelOverride, isCoreGameOver, isDisplayGameOver, loading, error]);

    useEffect(() => {
        const canSaveSummary = isDisplayGameOver && 
                             !hasAcknowledgedGameOver && 
                             !showEndGamePanelOverride &&
                             currentDepth === liveMaxDepthAttainable && 
                             liveMaxDepthAttainable > 0 && 
                             currentDate && 
                             coreGameData &&
                             grid.length > 0 && grid[0].length > 0 && 
                             !loading && !error;

        if (canSaveSummary) {
            const dailyProgressDataFromStorage = storage.loadDailyProgress(currentDate!);

            if (dailyProgressDataFromStorage[difficulty]?.completed && dailyProgressDataFromStorage[difficulty]?.summary) {
                 if (!dailyProgress[difficulty]) {
                    setDailyProgress((prev) => ({ ...prev, [difficulty]: true }));
                }
                return; 
            }

            const summaryToSave: LevelCompletionSummary = {
                history: history, 
                score: currentDepth,
                playerWords: Array.from(livePlayerUniqueWordsFound),
                maxScore: liveMaxDepthAttainable,
                optimalPathWords: liveOptimalPathWords,
                difficultyForSummary: difficulty,
                finalGrid: grid, 
            };
            console.log(`[SaveSummaryEffect] Saving summary for ${difficulty}:`, summaryToSave);

            // Ensure the difficulty entry exists
            if (!dailyProgressDataFromStorage[difficulty]) {
                dailyProgressDataFromStorage[difficulty] = { completed: false };
            }
            dailyProgressDataFromStorage[difficulty]!.completed = true;
            dailyProgressDataFromStorage[difficulty]!.summary = summaryToSave;
            
            setDailyProgress((prev) => ({ ...prev, [difficulty]: true })); 
            storage.saveDailyProgress(currentDate!, dailyProgressDataFromStorage);
        }
    }, [
        isDisplayGameOver, hasAcknowledgedGameOver, showEndGamePanelOverride, currentDepth,
        liveMaxDepthAttainable, currentDate, coreGameData, difficulty, history, grid,
        livePlayerUniqueWordsFound, liveOptimalPathWords, loading, dailyProgress, error 
    ]);

    useEffect(() => {
        if (difficulty === 'impossible' || error || !coreGameData) {
            setHintCells([]);
            if (hintTimeoutRef.current) clearTimeout(hintTimeoutRef.current);
            return;
        }
        if (turnFailedAttempts >= 3 && !isDisplayGameOver && !showEndGamePanelOverride && !loading && grid.length > 0 && grid[0].length > 0) {
            const coordinates = gameLogicRef.current.calculateHintCoordinates(); 
            if (coordinates.length > 0) {
                setHintCells(coordinates);
                if (hintTimeoutRef.current) clearTimeout(hintTimeoutRef.current);
                hintTimeoutRef.current = window.setTimeout(() => {
                    setHintCells([]); hintTimeoutRef.current = null;
                }, 3000);
            }
        }
    }, [turnFailedAttempts, grid, isDisplayGameOver, showEndGamePanelOverride, loading, difficulty, error, coreGameData]);

    useEffect(() => {
        return () => {
            if (animationTimeoutRef.current) clearTimeout(animationTimeoutRef.current);
            if (highlightTimeoutRef.current) clearTimeout(highlightTimeoutRef.current);
            if (wiggleTimeoutRef.current) clearTimeout(wiggleTimeoutRef.current);
            if (hintTimeoutRef.current) clearTimeout(hintTimeoutRef.current);
        };
    }, []);

    const performSwap = useCallback(
        (cell1: CellCoordinates, cell2: CellCoordinates) => {
            if (showEndGamePanelOverride || isDisplayGameOver || !coreGameData || animationState.animating || loading || error) return; 

            setSelectedCell(null);setDraggedCell(null);setHoveredCell(null);

            const result = gameLogicRef.current.performSwap(cell1, cell2);
            updateReactStateFromCore(result.newState || gameLogicRef.current.getCurrentGameState()); 

            if (result.success && result.newState && result.wordsFormed && result.moveDetails) {
                setAnimationState({ animating: true, from: cell1, to: cell2 });
                setIsInvalidMove(false);setInvalidMoveMessage('');
                if (highlightTimeoutRef.current) clearTimeout(highlightTimeoutRef.current);
                setHighlightedCells([]); 

                animationTimeoutRef.current = window.setTimeout(() => {
                    const allFoundCoords: CellCoordinates[] = [];
                    if (result.wordsFormed && result.moveDetails && result.newState?.grid) {
                         result.wordsFormed.forEach((word: string) => {
                            const coordsAttempt = findWordCoordinates(result.newState!.grid, word, result.moveDetails!);
                            if (coordsAttempt) allFoundCoords.push(...coordsAttempt);
                        });
                    }
                    const uniqueHighlightedCellsMap = new Map<string, CellCoordinates>();
                    allFoundCoords.forEach(coord => { if (coord) uniqueHighlightedCellsMap.set(`${coord.row}-${coord.col}`, coord); });
                    setHighlightedCells(Array.from(uniqueHighlightedCellsMap.values()));
                    
                    setAnimationState({ animating: false, from: null, to: null });
                    animationTimeoutRef.current = null;

                    highlightTimeoutRef.current = window.setTimeout(() => {
                        setHighlightedCells([]); highlightTimeoutRef.current = null;
                    }, 1500);

                }, 300); 
            } else { 
                if (!isCoreGameOver) { 
                    setIsInvalidMove(true);
                    setInvalidMoveMessage(result.message || 'Invalid Move!');
                    if (result.message !== "Game is over.") triggerWiggle(cell1, cell2);
                }
            }
        },
        [coreGameData, animationState.animating, isDisplayGameOver, loading, error, triggerWiggle, updateReactStateFromCore, isCoreGameOver, showEndGamePanelOverride]
    );

    const handleDragStart = useCallback((cellCoords: CellCoordinates) => {
        if (showEndGamePanelOverride || isDisplayGameOver || animationState.animating || !coreGameData || loading || error) return;
        setDraggedCell(cellCoords);setSelectedCell(null);setIsInvalidMove(false);setInvalidMoveMessage('');setHoveredCell(null);
        if (highlightTimeoutRef.current) clearTimeout(highlightTimeoutRef.current); setHighlightedCells([]);
        if (wiggleTimeoutRef.current) clearTimeout(wiggleTimeoutRef.current); setWiggleCells([]);
        if (hintTimeoutRef.current) clearTimeout(hintTimeoutRef.current); setHintCells([]);
    }, [animationState.animating, isDisplayGameOver, coreGameData, loading, error, showEndGamePanelOverride]);

    const handleDragEnter = useCallback((cellCoords: CellCoordinates) => {
        if (isDisplayGameOver || showEndGamePanelOverride || animationState.animating) return;
        if (draggedCell && (draggedCell.row !== cellCoords.row || draggedCell.col !== cellCoords.col)) {
            if (areAdjacent(draggedCell, cellCoords)) setHoveredCell(cellCoords);
            else setHoveredCell(null);
        }
    }, [draggedCell, isDisplayGameOver, showEndGamePanelOverride, animationState.animating]);

    const handleDragLeave = useCallback((cellCoords: CellCoordinates) => {
        if (isDisplayGameOver || showEndGamePanelOverride || animationState.animating) return;
        if (hoveredCell && hoveredCell.row === cellCoords.row && hoveredCell.col === cellCoords.col) {
            setHoveredCell(null);
        }
    }, [hoveredCell, isDisplayGameOver, showEndGamePanelOverride, animationState.animating]);

    const handleDragEnd = useCallback(() => {
        if (isDisplayGameOver || showEndGamePanelOverride || animationState.animating) return;
        setDraggedCell(null);setHoveredCell(null);
    }, [isDisplayGameOver, showEndGamePanelOverride, animationState.animating]);

    const handleDrop = useCallback((targetCellCoords: CellCoordinates) => {
        if (showEndGamePanelOverride || isDisplayGameOver || !draggedCell || loading || animationState.animating || error) { 
            setDraggedCell(null); setHoveredCell(null); return;
        }
        const sourceCell = draggedCell;
        setHoveredCell(null);
        if (sourceCell.row === targetCellCoords.row && sourceCell.col === targetCellCoords.col) {
            setDraggedCell(null); return;
        }
        if (!areAdjacent(sourceCell, targetCellCoords)) { 
            if (!isCoreGameOver) { 
                setIsInvalidMove(true);setInvalidMoveMessage('Must swap adjacent cells.');
                triggerWiggle(sourceCell, targetCellCoords);
            }
            setDraggedCell(null);return;
        }
        performSwap(sourceCell, targetCellCoords); 
        setDraggedCell(null);
    }, [draggedCell, performSwap, triggerWiggle, loading, animationState.animating, error, isDisplayGameOver, isCoreGameOver, showEndGamePanelOverride]);

    const handleCellClick = useCallback((cellCoords: CellCoordinates) => {
        if (showEndGamePanelOverride || isDisplayGameOver || animationState.animating || !coreGameData || draggedCell || loading || error) return; 
        if(!isCoreGameOver) { setIsInvalidMove(false); setInvalidMoveMessage('');}
        if (!selectedCell) {
            setSelectedCell(cellCoords);
        } else {
            const firstCell = selectedCell;
            if (firstCell.row === cellCoords.row && firstCell.col === cellCoords.col) {
                setSelectedCell(null);
            } else if (areAdjacent(firstCell, cellCoords)) {
                performSwap(firstCell, cellCoords); 
                setSelectedCell(null);
            } else {
                setSelectedCell(cellCoords);
            }
        }
    }, [selectedCell, animationState.animating, isDisplayGameOver, coreGameData, performSwap, draggedCell, loading, error, isCoreGameOver, showEndGamePanelOverride]);

    const handleReset = useCallback(() => {
        if (!currentDate || !coreGameData || showEndGamePanelOverride || animationState.animating || error) {
            console.warn("[handleReset] Reset blocked: Conditions not met."); return;
        }
        if (animationTimeoutRef.current) clearTimeout(animationTimeoutRef.current);
        if (highlightTimeoutRef.current) clearTimeout(highlightTimeoutRef.current);
        if (wiggleTimeoutRef.current) clearTimeout(wiggleTimeoutRef.current);
        if (hintTimeoutRef.current) clearTimeout(hintTimeoutRef.current);

        const coreStateAfterReset = gameLogicRef.current.resetLevel();
        updateReactStateFromCore(coreStateAfterReset);
        
        setSelectedCell(null); setDraggedCell(null); setHoveredCell(null);
        setIsInvalidMove(false); setInvalidMoveMessage('');
        setAnimationState({ animating: false, from: null, to: null });
        setHighlightedCells([]); setWiggleCells([]); setHintCells([]);
        setIsDisplayGameOver(false); setHasAcknowledgedGameOver(false);

        if (currentDate && difficulty) { // Ensure date and difficulty are defined
            storage.removeInProgressState(currentDate, difficulty);
        }
        
    }, [currentDate, difficulty, coreGameData, showEndGamePanelOverride, animationState.animating, error, updateReactStateFromCore]);

    const handleBack = useCallback(() => {
        if (history.length === 0 || animationState.animating || loading || error || showEndGamePanelOverride) return;
        if (animationTimeoutRef.current) clearTimeout(animationTimeoutRef.current);
        if (highlightTimeoutRef.current) clearTimeout(highlightTimeoutRef.current);
        if (wiggleTimeoutRef.current) clearTimeout(wiggleTimeoutRef.current);
        if (hintTimeoutRef.current) clearTimeout(hintTimeoutRef.current);

        const result = gameLogicRef.current.undoLastMove();
        if (result.success && result.newState && result.undoneMove) {
            if(isDisplayGameOver) { setIsDisplayGameOver(false);setHasAcknowledgedGameOver(false); }
            setIsInvalidMove(false); setInvalidMoveMessage('');
            setAnimationState({ animating: true, from: result.undoneMove.from, to: result.undoneMove.to });
            setHighlightedCells([]); setSelectedCell(null); setDraggedCell(null); setHoveredCell(null);
            setWiggleCells([]); setHintCells([]);

            animationTimeoutRef.current = window.setTimeout(() => {
                updateReactStateFromCore(result.newState!); 
                setAnimationState({ animating: false, from: null, to: null });
                animationTimeoutRef.current = null;
            }, 300);
        } else if (!result.success) {
            console.warn("Undo operation failed in core logic despite history being present.");
        }
    }, [history.length, animationState.animating, isDisplayGameOver, loading, error, updateReactStateFromCore, showEndGamePanelOverride]);

    const handleCloseGameOver = useCallback(() => {
        setHasAcknowledgedGameOver(true);
        setShowEndGamePanelOverride(false);
    }, []);

    const handlePlayMode = useCallback((newDifficulty: DifficultyLevel) => {
        if (showEndGamePanelOverride || difficulty === newDifficulty || animationState.animating || error) return; 
        if (newDifficulty === 'hard' && !dailyProgress.normal) {
            setInvalidMoveMessage("Complete Normal mode first!");setIsInvalidMove(true);
            setTimeout(() => {setIsInvalidMove(false); setInvalidMoveMessage('');}, 3000); return;
        }
        if (newDifficulty === 'impossible' && (!dailyProgress.normal || !dailyProgress.hard)) {
            setInvalidMoveMessage("Complete Normal & Hard modes first!");setIsInvalidMove(true);
            setTimeout(() => {setIsInvalidMove(false); setInvalidMoveMessage('');}, 3000); return;
        }
        setLoading(true);setDifficulty(newDifficulty); 
        masterResetGameStates();
    }, [showEndGamePanelOverride, difficulty, animationState.animating, error, dailyProgress, masterResetGameStates]);

    const handleHintButtonClick = useCallback(() => {
        if (showEndGamePanelOverride || isDisplayGameOver || difficulty === 'impossible' || animationState.animating || loading || !grid || grid.length === 0 || grid[0].length === 0 || hintCells.length > 0 || error || !coreGameData) return;
        const coordinates = gameLogicRef.current.calculateHintCoordinates();
        if (coordinates.length > 0) {
            setHintCells(coordinates);
            if (hintTimeoutRef.current) clearTimeout(hintTimeoutRef.current);
            hintTimeoutRef.current = window.setTimeout(() => { setHintCells([]); hintTimeoutRef.current = null; }, 3000);
        }
    }, [coreGameData, grid, difficulty, animationState.animating, showEndGamePanelOverride, isDisplayGameOver, loading, hintCells.length, error]);

    const handleShowGameSummary = useCallback(() => {
        if (!currentDate || loading || error) { console.warn("Cannot show summary: Conditions not met."); return; }
        
        const loadedSummaries = storage.loadAllSummariesForDate(currentDate, difficulties);

        if (Object.values(loadedSummaries).some(s => s !== null)) {
            setCombinedSummaryData(loadedSummaries);
            setShowEndGamePanelOverride(true);setHasAcknowledgedGameOver(true);setIsDisplayGameOver(true);
        } else {
            setInvalidMoveMessage(`No summaries available for ${getFriendlyDate(currentDate)}.`); setIsInvalidMove(true); 
            setTimeout(() => {setIsInvalidMove(false); setInvalidMoveMessage('');}, 3000);
        }
    }, [currentDate, loading, error]);

    const handleViewMySolution = useCallback(() => {
        if (!currentDate || !coreGameData || animationState.animating || showEndGamePanelOverride || error || loading) { 
            console.warn("View solution blocked: conditions not met."); return;
        } 

        const summary = storage.loadSummaryForDifficulty(currentDate, difficulty);

        if (summary && summary.finalGrid && Array.isArray(summary.finalGrid)) {
            if (animationTimeoutRef.current) clearTimeout(animationTimeoutRef.current);
            if (highlightTimeoutRef.current) clearTimeout(highlightTimeoutRef.current);
            if (wiggleTimeoutRef.current) clearTimeout(wiggleTimeoutRef.current);
            if (hintTimeoutRef.current) clearTimeout(hintTimeoutRef.current);
            setHighlightedCells([]); setWiggleCells([]); setHintCells([]);setSelectedCell(null); setDraggedCell(null); setHoveredCell(null);
            setInvalidMoveMessage(''); setIsInvalidMove(false);setAnimationState({ animating: false, from: null, to: null });

            const solutionState = gameLogicRef.current.setStateForSolutionView(summary.finalGrid, summary.history, summary.score);
            updateReactStateFromCore(solutionState);
            
            setIsDisplayGameOver(true); setHasAcknowledgedGameOver(true); setShowEndGamePanelOverride(false);
            console.log(`Loaded solution for ${difficulty}. Grid and history updated.`);
        } else {
            setInvalidMoveMessage(`No solution data found for ${difficulty}.`); setIsInvalidMove(true);
            setTimeout(() => {setIsInvalidMove(false); setInvalidMoveMessage('');}, 3000);
        }
    }, [currentDate, difficulty, coreGameData, animationState.animating, showEndGamePanelOverride, error, updateReactStateFromCore, loading]);

    const { normalDataForPanel, hardDataForPanel, impossibleDataForPanel } = useMemo(() => {
        let normalData: LevelResultData | null = null;
        let hardData: LevelResultData | null = null;
        let impossibleData: LevelResultData | null = null;

        if (showEndGamePanelOverride && combinedSummaryData && Object.keys(combinedSummaryData).length > 0) {
            difficulties.forEach(diffLevel => {
                const summary = combinedSummaryData[diffLevel];
                if (summary) {
                    const data = { ...summary, levelCompleted: summary.score === summary.maxScore };
                    if (diffLevel === 'normal') normalData = data;
                    else if (diffLevel === 'hard') hardData = data;
                    else if (diffLevel === 'impossible') impossibleData = data;
                }
            });
        } 
        else if (isDisplayGameOver && !hasAcknowledgedGameOver && coreGameData && currentDate && !error) {
            const liveDataForCurrentDifficulty: LevelResultData = {
                history: history, score: currentDepth, maxScore: liveMaxDepthAttainable,
                optimalPathWords: liveOptimalPathWords,
                levelCompleted: currentDepth === liveMaxDepthAttainable && liveMaxDepthAttainable > 0,
            };

            const allSavedSummaries = storage.loadDailyProgress(currentDate);

            difficulties.forEach(diffLevel => {
                let dataToSet: LevelResultData | null = null;
                if (diffLevel === difficulty) {
                    dataToSet = liveDataForCurrentDifficulty;
                } else if (allSavedSummaries[diffLevel]?.summary) {
                    const summary = allSavedSummaries[diffLevel]!.summary!;
                    dataToSet = {
                        history: summary.history, score: summary.score, maxScore: summary.maxScore,
                        optimalPathWords: summary.optimalPathWords, levelCompleted: summary.score === summary.maxScore,
                    };
                }
                if (diffLevel === 'normal') normalData = dataToSet;
                else if (diffLevel === 'hard') hardData = dataToSet;
                else if (diffLevel === 'impossible') impossibleData = dataToSet;
            });
        }
        return { normalDataForPanel: normalData, hardDataForPanel: hardData, impossibleDataForPanel: impossibleData };
    }, [showEndGamePanelOverride, combinedSummaryData, isDisplayGameOver, hasAcknowledgedGameOver, coreGameData, currentDate, history, currentDepth, liveMaxDepthAttainable, liveOptimalPathWords, difficulty, error]);


    return {
        darkMode, loading, error, currentDate, difficulty, dailyProgress, isDebugMode,
        grid, currentPossibleMoves, currentDepth, history, hasDeviated, turnFailedAttempts, coreGameData,
        selectedCell, draggedCell, hoveredCell, isInvalidMove, invalidMoveMessage,
        animationState, highlightedCells, wiggleCells, hintCells,
        isGameOver: isDisplayGameOver, hasAcknowledgedGameOver, showEndGamePanelOverride, combinedSummaryData,
        liveOptimalPathWords, livePlayerUniqueWordsFound, liveMaxDepthAttainable, wordLength,
        normalDataForPanel, hardDataForPanel, impossibleDataForPanel,
        setDarkMode, 
        handleCellClick, handleDragStart, handleDragEnter, handleDragLeave, handleDrop,
        handleReset, handleBack, handleCloseGameOver, handlePlayMode, handleHintButtonClick,
        handleShowGameSummary, handleViewMySolution, masterResetGameStates
    };
};