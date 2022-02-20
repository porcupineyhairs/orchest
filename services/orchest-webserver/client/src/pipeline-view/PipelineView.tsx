import { IconButton } from "@/components/common/IconButton";
import { Layout } from "@/components/Layout";
import { useAppContext } from "@/contexts/AppContext";
import { useProjectsContext } from "@/contexts/ProjectsContext";
import { useCustomRoute } from "@/hooks/useCustomRoute";
import { useFetchEnvironments } from "@/hooks/useFetchEnvironments";
import { useHotKeys } from "@/hooks/useHotKeys";
import { useSendAnalyticEvent } from "@/hooks/useSendAnalyticEvent";
import StyledButtonOutlined from "@/styled-components/StyledButton";
import type {
  Connection,
  PipelineJson,
  PipelineRun,
  PipelineStepState,
} from "@/types";
import { layoutPipeline } from "@/utils/pipeline-layout";
import {
  checkGate,
  filterServices,
  getPipelineJSONEndpoint,
  getScrollLineHeight,
  validatePipeline,
} from "@/utils/webserver-utils";
import AccountTreeOutlinedIcon from "@mui/icons-material/AccountTreeOutlined";
import AddIcon from "@mui/icons-material/Add";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import CloseIcon from "@mui/icons-material/Close";
import CropFreeIcon from "@mui/icons-material/CropFree";
import DeleteIcon from "@mui/icons-material/Delete";
import RemoveIcon from "@mui/icons-material/Remove";
import SettingsIcon from "@mui/icons-material/Settings";
import TuneIcon from "@mui/icons-material/Tune";
import ViewHeadlineIcon from "@mui/icons-material/ViewHeadline";
import VisibilityIcon from "@mui/icons-material/Visibility";
import Button from "@mui/material/Button";
import { darken } from "@mui/material/styles";
import {
  activeElementIsInput,
  collapseDoubleDots,
  fetcher,
  hasValue,
  HEADER,
  PromiseManager,
  RefManager,
  uuidv4,
} from "@orchest/lib-utils";
import $ from "jquery";
import React from "react";
import io from "socket.io-client";
import { siteMap } from "../Routes";
import { extractStepsFromPipelineJson, updatePipelineJson } from "./common";
import PipelineConnection from "./PipelineConnection";
import { PipelineDetails } from "./PipelineDetails";
import PipelineStep, { STEP_HEIGHT, STEP_WIDTH } from "./PipelineStep";
import { getStepSelectorRectangle, Rectangle } from "./Rectangle";
import { ServicesMenu } from "./ServicesMenu";
import { useAutoStartSession } from "./useAutoStartSession";
import {
  nodeCenter,
  scaleCorrectedPosition,
  useEventVars,
} from "./useEventVars";
import {
  convertStepsToObject,
  useStepExecutionState,
} from "./useStepExecutionState";

const CANVAS_VIEW_MULTIPLE = 3;
const DOUBLE_CLICK_TIMEOUT = 300;
const INITIAL_PIPELINE_POSITION = [-1, -1];
const DEFAULT_SCALE_FACTOR = 1;

export type Step = Record<string, PipelineStepState>;

type RunStepsType = "selection" | "incoming";

const PIPELINE_RUN_STATUS_ENDPOINT = "/catch/api-proxy/api/runs/";
const PIPELINE_JOBS_STATUS_ENDPOINT = "/catch/api-proxy/api/jobs/";

const originTransformScaling = (
  origin: [number, number],
  scaleFactor: number
) => {
  /* By multiplying the transform-origin with the scaleFactor we get the right
   * displacement for the transformed/scaled parent (pipelineStepHolder)
   * that avoids visual displacement when the origin of the
   * transformed/scaled parent is modified.
   *
   * the adjustedScaleFactor was derived by analysing the geometric behavior
   * of applying the css transform: translate(...) scale(...);.
   */

  let adjustedScaleFactor = scaleFactor - 1;
  origin[0] *= adjustedScaleFactor;
  origin[1] *= adjustedScaleFactor;
  return origin;
};

const PipelineView: React.FC = () => {
  const { dispatch } = useProjectsContext();
  const { setAlert, setConfirm, requestBuild } = useAppContext();
  useSendAnalyticEvent("view load", { name: siteMap.pipeline.path });

  const {
    projectUuid,
    pipelineUuid,
    jobUuid: jobUuidFromRoute,
    runUuid: runUuidFromRoute,
    isReadOnly: isReadOnlyFromQueryString,
    navigateTo,
  } = useCustomRoute();

  const [isReadOnly, _setIsReadOnly] = React.useState(
    isReadOnlyFromQueryString
  );

  const [pipelineJson, setPipelineJson] = React.useState<PipelineJson>(null);

  const setIsReadOnly = (readOnly: boolean) => {
    dispatch({
      type: "SET_PIPELINE_IS_READONLY",
      payload: readOnly,
    });
    _setIsReadOnly(readOnly);
  };

  const [prevPosition, setPrevPosition] = React.useState<[number, number]>([
    0,
    0,
  ]);
  const [draggingCanvas, setDraggingCanvas] = React.useState(false);
  const isPipelineInitialized = React.useRef(false);
  const pipelineStepsOuterHolder = React.useRef<HTMLDivElement>();
  const pipelineStepsHolder = React.useRef<HTMLDivElement>();

  const [mouseClient, setMouseClient] = React.useState<{
    x: number;
    y: number;
  }>({ x: 0, y: 0 });
  const [eventVars, eventVarsDispatch, stepDomRefs] = useEventVars();

  const removeCreatingConnectionStyling = React.useCallback(() => {
    $(".incoming-connections").removeClass("hover");
    $(".pipeline-step").removeClass("creating-connection");
  }, []);

  const pipelineSetHolderSize = React.useCallback(() => {
    // TODO: resize canvas based on pipeline size
    if (!pipelineStepsOuterHolder.current || !pipelineStepsHolder.current)
      return;

    let jElStepOuterHolder = $(pipelineStepsOuterHolder.current);

    if (jElStepOuterHolder.filter(":visible").length > 0) {
      $(pipelineStepsHolder.current).css({
        width: jElStepOuterHolder.width() * CANVAS_VIEW_MULTIPLE,
        height: jElStepOuterHolder.height() * CANVAS_VIEW_MULTIPLE,
      });
    }
  }, []);

  const finishCreatingConnection = React.useCallback(
    (endNodeUUID: string) => {
      eventVarsDispatch({ type: "MAKE_CONNECTION", payload: endNodeUUID });
      removeCreatingConnectionStyling();
      setSaveHash(uuidv4());
    },
    [eventVarsDispatch, removeCreatingConnectionStyling]
  );

  const onMouseUpPipelineStep = React.useCallback(
    (endNodeUUID: string) => finishCreatingConnection(endNodeUUID),
    [finishCreatingConnection]
  );

  // TODO: put document event listeners here
  React.useLayoutEffect(() => {
    // if (!isReadOnly && !isPipelineInitialized.current) {
    //   initializePipelineEditListeners();
    // }

    if (isReadOnly) {
      // document.addEventListener("mouseup", onMouseUp);
    }
    window.addEventListener("resize", pipelineSetHolderSize);
    return () => {
      // document.removeEventListener("mouseup", onMouseUp);
      window.removeEventListener("resize", pipelineSetHolderSize);
    };
  }, [isReadOnly]);

  const session = useAutoStartSession({
    projectUuid,
    pipelineUuid,
    isReadOnly,
  });

  const [isHoverEditor, setIsHoverEditor] = React.useState(false);
  const { setScope } = useHotKeys(
    {
      "pipeline-editor": {
        "ctrl+a, command+a, ctrl+enter, command+enter": (e, hotKeyEvent) => {
          if (["ctrl+a", "command+a"].includes(hotKeyEvent.key)) {
            e.preventDefault();

            eventVarsDispatch({
              type: "SELECT_STEPS",
              payload: Object.keys(eventVars.steps),
            });
          }
          if (["ctrl+enter", "command+enter"].includes(hotKeyEvent.key))
            runSelectedSteps();
        },
      },
    },
    [isHoverEditor],
    isHoverEditor
  );

  const timersRef = React.useRef({
    doubleClickTimeout: undefined,
    saveIndicatorTimeout: undefined,
  });

  // The save hash is used to propagate a save's side-effects to components.
  const [saveHash, setSaveHash] = React.useState<string>();
  const [pipelineCwd, setPipelineCwd] = React.useState("");

  const [isDeletingSteps, setIsDeletingSteps] = React.useState(false);
  const [pendingRuns, setPendingRuns] = React.useState<
    { uuids: string[]; type: RunStepsType } | undefined
  >();

  const [pipelineRunning, setPipelineRunning] = React.useState(false);
  const [isCancellingRun, setIsCancellingRun] = React.useState(false);

  const [runUuid, setRunUuid] = React.useState(runUuidFromRoute);
  const runStatusEndpoint = jobUuidFromRoute
    ? `${PIPELINE_JOBS_STATUS_ENDPOINT}${jobUuidFromRoute}/`
    : PIPELINE_RUN_STATUS_ENDPOINT;

  const { stepExecutionState, setStepExecutionState } = useStepExecutionState(
    runUuid ? `${runStatusEndpoint}${runUuid}` : null,
    (runStatus) => {
      if (["PENDING", "STARTED"].includes(runStatus)) {
        setPipelineRunning(true);
      }

      if (["SUCCESS", "ABORTED", "FAILURE"].includes(runStatus)) {
        // make sure stale opened files are reloaded in active
        // Jupyter instance

        if (window.orchest.jupyter)
          window.orchest.jupyter.reloadFilesFromDisk();

        setPipelineRunning(false);
        setIsCancellingRun(false);
      }
    }
  );

  interface IPipelineViewState {
    // rendering state
    pipelineOrigin: number[];
    pipelineStepsHolderOffsetLeft: number;
    pipelineStepsHolderOffsetTop: number;
    pipelineOffset: [number, number];
    // misc. state
    sio: any;
    currentOngoingSaves: number;
    defaultDetailViewIndex: number;
  }

  let initialState: IPipelineViewState = {
    // rendering state
    pipelineOrigin: [0, 0],
    pipelineStepsHolderOffsetLeft: 0,
    pipelineStepsHolderOffsetTop: 0,
    pipelineOffset: [
      INITIAL_PIPELINE_POSITION[0],
      INITIAL_PIPELINE_POSITION[1],
    ],
    // misc. state
    sio: undefined,
    currentOngoingSaves: 0,
    defaultDetailViewIndex: 0,
  };

  const refManager = React.useMemo(() => new RefManager(), []);
  const promiseManager = React.useMemo(() => new PromiseManager(), []);

  const [state, _setState] = React.useState<IPipelineViewState>(initialState);
  // TODO: clean up this class-component-stye setState
  const setState = (
    newState:
      | Partial<IPipelineViewState>
      | ((
          previousState: Partial<IPipelineViewState>
        ) => Partial<IPipelineViewState>)
  ) => {
    _setState((prevState) => {
      let updatedState =
        newState instanceof Function ? newState(prevState) : newState;

      return {
        ...prevState,
        ...updatedState,
      };
    });
  };

  const fetchActivePipelineRuns = () => {
    fetcher(
      `${PIPELINE_RUN_STATUS_ENDPOINT}?project_uuid=${projectUuid}&pipeline_uuid=${pipelineUuid}`
    )
      .then((data) => {
        try {
          // Note that runs are returned by the orchest-api by
          // started_time DESC. So we can just retrieve the first run.
          if (data["runs"].length > 0) {
            let run = data["runs"][0];

            setRunUuid(run.uuid);
          }
        } catch (e) {
          console.log("Error parsing return from orchest-api " + e);
        }
      })
      .catch((error) => {
        if (!error.isCanceled) {
          console.error(error);
        }
      });
  };

  const savePipeline = (callback?: () => void) => {
    if (!isReadOnly) {
      let updatedPipelineJson = updatePipelineJson(
        pipelineJson,
        eventVars.steps
      );

      // validate pipelineJSON
      let pipelineValidation = validatePipeline(updatedPipelineJson);

      // if invalid
      if (!pipelineValidation.valid) {
        // Just show the first error
        setAlert("Error", pipelineValidation.errors[0]);
      } else {
        // store pipeline.json
        let formData = new FormData();
        formData.append("pipeline_json", JSON.stringify(updatedPipelineJson));

        setState((state) => {
          return {
            currentOngoingSaves: state.currentOngoingSaves + 1,
          };
        });

        clearTimeout(timersRef.current.saveIndicatorTimeout);
        timersRef.current.saveIndicatorTimeout = setTimeout(() => {
          dispatch({
            type: "pipelineSetSaveStatus",
            payload: "saving",
          });
        }, 100);

        // perform POST to save
        fetcher(`/async/pipelines/json/${projectUuid}/${pipelineUuid}`, {
          method: "POST",
          body: formData,
        })
          .then(() => {
            if (callback && typeof callback == "function") {
              callback();
            }
            decrementSaveCounter();
          })
          .catch((reason) => {
            if (!reason.isCanceled) {
              decrementSaveCounter();
            }
          });
      }
    } else {
      console.error("savePipeline should be uncallable in readOnly mode.");
    }
  };

  const decrementSaveCounter = () => {
    setState((state) => {
      return {
        currentOngoingSaves: state.currentOngoingSaves - 1,
      };
    });
  };

  const getPipelineJSON = () => {
    let steps = eventVars.steps;
    return { ...pipelineJson, steps };
  };

  const setPipelineSteps = (steps: Record<string, PipelineStepState>) => {
    eventVarsDispatch({ type: "SET_STEPS", payload: steps });
  };

  const isJobRun = jobUuidFromRoute && runUuid;
  const jobRunQueryArgs = {
    jobUuid: jobUuidFromRoute,
    runUuid,
  };

  const openSettings = (e: React.MouseEvent) => {
    navigateTo(
      siteMap.pipelineSettings.path,
      {
        query: {
          projectUuid,
          pipelineUuid,
          ...(isJobRun ? jobRunQueryArgs : undefined),
        },
        state: { isReadOnly },
      },
      e
    );
  };

  const openLogs = (e: React.MouseEvent) => {
    navigateTo(
      siteMap.logs.path,
      {
        query: {
          projectUuid,
          pipelineUuid,
          ...(isJobRun ? jobRunQueryArgs : undefined),
        },
        state: { isReadOnly },
      },
      e
    );
  };

  const onOpenFilePreviewView = (e: React.MouseEvent, stepUuid: string) => {
    navigateTo(
      siteMap.filePreview.path,
      {
        query: {
          projectUuid,
          pipelineUuid,
          stepUuid,
          ...(isJobRun ? jobRunQueryArgs : undefined),
        },
        state: { isReadOnly },
      },
      e
    );
  };

  const openNotebook = (e: React.MouseEvent, stepUUID: string) => {
    if (session === undefined) {
      setAlert(
        "Error",
        "Please start the session before opening the Notebook in Jupyter."
      );
    } else if (session.status === "RUNNING") {
      const filePath = collapseDoubleDots(
        pipelineCwd + eventVars.steps[stepUUID].file_path
      ).slice(1);
      navigateTo(
        siteMap.jupyterLab.path,
        {
          query: {
            projectUuid,
            pipelineUuid,
            filePath,
          },
        },
        e
      );
    } else if (session.status === "LAUNCHING") {
      setAlert(
        "Error",
        "Please wait for the session to start before opening the Notebook in Jupyter."
      );
    } else {
      setAlert(
        "Error",
        "Please start the session before opening the Notebook in Jupyter."
      );
    }
  };

  const [isShowingServices, setIsShowingServices] = React.useState(false);

  const showServices = () => {
    setIsShowingServices(true);
  };

  const hideServices = () => {
    setIsShowingServices(false);
  };

  const initializeResizeHandlers = () => {
    $(window).resize(() => {
      pipelineSetHolderSize();
    });
  };

  // TODO: only make state.sio defined after successful
  // connect to avoid .emit()'ing to unconnected
  // sio client (emits aren't buffered).
  const connectSocketIO = () => {
    // disable polling
    setState({
      sio: io.connect("/pty", { transports: ["websocket"] }),
    });
  };

  const disconnectSocketIO = () => {
    if (state.sio) {
      state.sio.disconnect();
    }
  };

  const onClickConnection = (
    e: MouseEvent,
    startNodeUUID: string,
    endNodeUUID: string
  ) => {
    eventVarsDispatch((state) => {
      // if space is pressed, user probably wants to drag the canvas, but accidentally key down on a connection
      // connection has transparent background, user might think they key down on the canvas, but they actually key down on a connection
      if (e.button === 0 && !state.keysDown[32]) {
        return {
          type: "SELECT_CONNECTION",
          payload: { startNodeUUID, endNodeUUID },
        };
      }
    });
  };

  const createConnectionInstance = (
    startNodeUUID: string,
    endNodeUUID?: string | undefined
  ) => {
    let newConnection: Connection = {
      xEnd: undefined,
      yEnd: undefined,
      startNodeUUID,
      endNodeUUID,
      selected: false,
    };

    eventVarsDispatch({
      type: "CREATE_CONNECTION_INSTANCE",
      payload: newConnection,
    });
  };

  const removeConnection = React.useCallback(
    (connection: Connection) => {
      eventVarsDispatch({ type: "REMOVE_CONNECTION", payload: connection });
      setSaveHash(uuidv4());
    },
    [eventVarsDispatch]
  );

  const initializePipelineEditListeners = () => {
    $(pipelineStepsHolder.current).on(
      "mousedown",
      ".pipeline-step .outgoing-connections",
      (e) => {
        if (e.button === 0) {
          $(e.target).parents(".pipeline-step").addClass("creating-connection");
          // create connection
          const startNodeUUID = $(e.target)
            .parents(".pipeline-step")
            .attr("data-uuid");

          createConnectionInstance(startNodeUUID);
        }
      }
    );

    $(document).on("keydown.initializePipeline", (e) => {
      if (
        !isDeletingSteps &&
        !activeElementIsInput() &&
        (e.keyCode === 8 || e.keyCode === 46)
      ) {
        // Make sure that successively pressing backspace does not trigger
        // another delete.

        deleteSelectedSteps();
      }
    });

    $(document).on("keyup.initializePipeline", (e) => {
      if (!activeElementIsInput() && (e.keyCode === 8 || e.keyCode === 46)) {
        if (eventVars.selectedConnection) {
          e.preventDefault();

          removeConnection(eventVars.selectedConnection);
        }
      }
    });
  };

  /*
  // TODO: uncomment and fix this
  const initializePipelineNavigationListeners = () => {
    $(pipelineStepsHolder.current).on(
      "mousedown",
      ".pipeline-step",
      (e) => {
        if (e.button === 0) {
          if (!$(e.target).hasClass("outgoing-connections")) {
            let stepUUID = $(e.currentTarget).attr("data-uuid");
            eventVars.selectedSingleStep = stepUUID;
            updateEventVars();
          }
        }
      }
    );

    $(document).on("mouseup.initializePipeline", (e) => {
      let stepClicked = false;
      let stepDragged = false;

      if (eventVars.selectedSingleStep !== undefined) {
        let step = eventVars.steps[eventVars.selectedSingleStep];

        if (!step.meta_data._dragged) {
          if (eventVars.selectedConnection) {
            deselectConnection();
          }

          if (!e.ctrlKey) {
            stepClicked = true;

            if (eventVars.doubleClickFirstClick) {
              refManager.refs[eventVars.selectedSingleStep].props.onDoubleClick(
                eventVars.selectedSingleStep
              );
            } else {
              refManager.refs[eventVars.selectedSingleStep].props.onClick(
                eventVars.selectedSingleStep
              );
            }

            eventVars.doubleClickFirstClick = true;
            clearTimeout(timersRef.current.doubleClickTimeout);
            timersRef.current.doubleClickTimeout = setTimeout(() => {
              eventVars.doubleClickFirstClick = false;
            }, DOUBLE_CLICK_TIMEOUT);
          } else {
            // if clicked step is not selected, select it on Ctrl+Mouseup
            if (
              eventVars.selectedSteps.indexOf(eventVars.selectedSingleStep) === -1
            ) {
              eventVars.selectedSteps = eventVars.selectedSteps.concat(
                eventVars.selectedSingleStep
              );

              updateEventVars();
            } else {
              // remove from selection
              eventVars.selectedSteps.splice(
                eventVars.selectedSteps.indexOf(eventVars.selectedSingleStep),
                1
              );
              updateEventVars();
            }
          }
        } else {
          stepDragged = true;
        }

        step.meta_data._dragged = false;
        step.meta_data._drag_count = 0;
      }

      // check if step needs to be selected based on selectedSteps
      if (
        eventVars.stepSelector.active ||
        eventVars.selectedSingleStep !== undefined
      ) {
        if (eventVars.selectedConnection) {
          deselectConnection();
        }

        if (
          eventVars.selectedSteps.length == 1 &&
          !stepClicked &&
          !stepDragged
        ) {
          selectStep(eventVars.selectedSteps[0]);
        } else if (eventVars.selectedSteps.length > 1 && !stepDragged) {
          // make sure single step detail view is closed
          closeDetailsView();

          updateEventVars();
        } else if (!stepDragged) {
          deselectSteps();
        }
      }

      // handle step selector
      if (eventVars.stepSelector.active) {
        // on mouse up trigger onClick if single step is selected
        // (only if not triggered by clickEnd)
        eventVars.stepSelector.active = false;
        updateEventVars();
      }

      if (stepDragged) setSaveHash(uuidv4());

      if (e.button === 0 && eventVars.selectedSteps.length == 0) {
        // when space bar is held make sure deselection does not occur
        // on click (as it is a drag event)

        if (
          (e.target === pipelineStepsOuterHolder.current ||
            e.target === pipelineStepsHolder.current) &&
          eventVars.draggingCanvas !== true
        ) {
          if (eventVars.selectedConnection) {
            deselectConnection();
          }

          deselectSteps();
        }
      }
      if (eventVars.selectedSingleStep !== undefined) {
        eventVars.selectedSingleStep = undefined;
        updateEventVars();
      }

      if (eventVars.draggingCanvas) {
        eventVars.draggingCanvas = false;
        updateEventVars();
      }
    });

    $(pipelineStepsHolder.current).on("mousedown", (e) => {
      eventVars.prevPosition = [
        scaleCorrectedPosition(e.clientX, eventVars.scaleFactor),
        scaleCorrectedPosition(e.clientY, eventVars.scaleFactor),
      ];
    });

    $(document).on("mousedown.initializePipeline", (e) => {
      const serviceClass = "services-status";
      if (
        $(e.target).parents("." + serviceClass).length == 0 &&
        !$(e.target).hasClass(serviceClass)
      ) {
        hideServices();
      }
    });

    $(document).on("keydown.initializePipeline", (e) => {
      if (e.keyCode == 72 && !activeElementIsInput()) {
        centerView();
      }

      eventVars.keysDown[e.keyCode] = true;
    });

    $(document).on("keyup.initializePipeline", (e) => {
      eventVars.keysDown[e.keyCode] = false;

      if (e.keyCode) {
        $(pipelineStepsOuterHolder.current).removeClass("dragging");

        eventVars.draggingCanvas = false;
        updateEventVars();
      }

      if (e.keyCode === 27) {
        if (eventVars.selectedConnection) {
          deselectConnection();
        }

        deselectSteps();
        closeDetailsView();
        hideServices();
      }
    });
  };
  */

  const initializePipeline = () => {
    // Initialize should be called only once
    // eventVars.steps is assumed to be populated
    // called after render, assumed dom elements are also available
    // (required by i.e. connections)

    pipelineSetHolderSize();

    if (isPipelineInitialized.current) return;

    isPipelineInitialized.current = true;

    // add all existing connections (this happens only at initialization)
    Object.values(eventVars.steps).forEach((step) => {
      step.incoming_connections.forEach((startNodeUUID) => {
        let endNodeUUID = step.uuid;

        createConnectionInstance(startNodeUUID, endNodeUUID);

        // ? Do we really need to cross-verify the UUID's???

        // let startNodeOutgoingEl = pipelineStepsHolder.current.querySelector(
        //   `.pipeline-step[data-uuid='${startNodeUUID}'] .outgoing-connections`
        // ) as HTMLElement;

        // let endNodeIncomingEl = pipelineStepsHolder.current.querySelector(
        //   `.pipeline-step[data-uuid='${endNodeUUID}'] .incoming-connections`
        // ) as HTMLElement;

        // if (startNodeOutgoingEl && endNodeIncomingEl) {
        //   const startNodeUUID = $(startNodeOutgoingEl)
        //     .parents(".pipeline-step")
        //     .attr("data-uuid");
        //   const endNodeUUID = $(endNodeIncomingEl)
        //     .parents(".pipeline-step")
        //     .attr("data-uuid");

        //   createConnectionInstance(startNodeUUID, endNodeUUID);
        // }
      });
    });

    // TODO: uncomment and fix this
    // initialize all listeners related to viewing/navigating the pipeline
    // initializePipelineNavigationListeners();
  };

  const fetchPipelineAndInitialize = () => {
    let promises = [];

    if (!isReadOnly) {
      // fetch pipeline cwd
      promises.push(
        fetcher(
          `/async/file-picker-tree/pipeline-cwd/${projectUuid}/${pipelineUuid}`
        )
          .then((cwdPromiseResult) => {
            // relativeToAbsolutePath expects trailing / for directories
            setPipelineCwd(`${cwdPromiseResult["cwd"]}/`);
          })
          .catch((error) => {
            if (!error.isCanceled) {
              console.error(error);
            }
          })
      );
    }

    promises.push(
      fetcher<{ success: boolean; pipeline_json: string }>(
        getPipelineJSONEndpoint(
          pipelineUuid,
          projectUuid,
          jobUuidFromRoute,
          runUuid
        )
      )
        .then((result) => {
          if (result.success) {
            const newPipelineJson: PipelineJson = JSON.parse(
              result.pipeline_json
            );
            let newSteps = extractStepsFromPipelineJson(
              newPipelineJson,
              eventVars.steps
            );
            // update steps & pipelineJson
            setPipelineJson(newPipelineJson);
            setPipelineSteps(newSteps);

            dispatch({
              type: "pipelineSet",
              payload: {
                pipelineUuid,
                projectUuid,
                pipelineName: newPipelineJson.name,
              },
            });
          } else {
            console.error("Could not load pipeline.json");
            console.error(result);
          }
        })
        .catch((error) => {
          if (!error.isCanceled) {
            if (jobUuidFromRoute) {
              // This case is hit when a user tries to load a pipeline that belongs
              // to a run that has not started yet. The project files are only
              // copied when the run starts. Before start, the pipeline.json thus
              // cannot be found. Alert the user about missing pipeline and return
              // to JobView.

              setAlert(
                "Error",
                "The .orchest pipeline file could not be found. This pipeline run has not been started. Returning to Job view.",
                (resolve) => {
                  resolve(true);
                  returnToJob();
                  return true;
                }
              );
            } else {
              console.error("Could not load pipeline.json");
              console.error(error);
            }
          }
        })
    );

    Promise.all(promises)
      .then(() => {
        initializePipeline();
      })
      .catch((error) => {
        console.error(error);
      });
  };

  const { data: environments = [] } = useFetchEnvironments(
    !isReadOnly ? projectUuid : undefined
  );

  const createNextStep = async () => {
    if (!pipelineStepsOuterHolder.current) {
      console.error(
        "Unable to create next step. pipelineStepsOuterHolder is not yet instantiated!"
      );
      return;
    }
    try {
      // Assume the first environment as the default
      // user can change it afterwards
      const environment = environments.length > 0 ? environments[0] : null;
      // When new steps are successively created then we don't want
      // them to be spawned on top of each other. NOTE: we use the
      // same offset for X and Y position.
      const { clientWidth, clientHeight } = pipelineStepsOuterHolder.current;
      const [pipelineOffsetX, pipelineOffsetY] = state.pipelineOffset;

      const position = [
        -pipelineOffsetX + clientWidth / 2 - STEP_WIDTH / 2,
        -pipelineOffsetY + clientHeight / 2 - STEP_HEIGHT / 2,
      ] as [number, number];

      eventVarsDispatch({
        type: "CREATE_STEP",
        payload: {
          title: "",
          uuid: uuidv4(),
          incoming_connections: [],
          file_path: "",
          kernel: {
            name: "python", // TODO: what is the default name? the default environment language might not be python
            display_name: environment?.name,
          },
          environment: environment?.uuid,
          parameters: {},
          meta_data: {
            position,
            _dragged: false,
            _drag_count: 0,
            hidden: false,
          },
        },
      });
      setSaveHash(uuidv4());
    } catch (error) {
      setAlert("Error", `Unable to create a new step. ${error}`);
    }
  };

  const selectStep = (stepUUID: string) => {
    eventVarsDispatch({ type: "SELECT_STEPS", payload: [stepUUID] });
  };

  const onClickStepHandler = (stepUUID: string) => {
    setTimeout(() => {
      selectStep(stepUUID);
    });
  };

  const onDoubleClickStepHandler = (stepUUID: string) => {
    if (isReadOnly) {
      onOpenFilePreviewView(undefined, stepUUID);
    } else {
      openNotebook(undefined, stepUUID);
    }
  };

  const deleteSelectedSteps = () => {
    // The if is to avoid the dialog appearing when no steps are
    // selected and the delete button is pressed.
    if (eventVars.selectedSteps.length > 0) {
      setIsDeletingSteps(true);

      setConfirm(
        "Warning",
        `A deleted step and its logs cannot be recovered once deleted, are you sure you want to proceed?`,
        {
          onConfirm: async (resolve) => {
            closeDetailsView();
            removeSteps(eventVars.selectedSteps);
            setIsDeletingSteps(false);
            setSaveHash(uuidv4());
            resolve(true);
            return true;
          },
          onCancel: (resolve) => {
            setIsDeletingSteps(false);
            resolve(false);
            return false;
          },
        }
      );
    }
  };

  const removeSteps = (uuids: string[]) => {
    eventVarsDispatch({ type: "REMOVE_STEPS", payload: uuids });
  };

  const onDetailsDelete = () => {
    let uuid = eventVars.openedStep;
    setConfirm(
      "Warning",
      "A deleted step and its logs cannot be recovered once deleted, are you sure you want to proceed?",
      async (resolve) => {
        removeSteps([uuid]);
        setSaveHash(uuidv4());
        resolve(true);
        return true;
      }
    );
  };

  const onOpenNotebook = (e: React.MouseEvent) => {
    openNotebook(e, eventVars.openedStep);
  };

  const centerView = () => {
    eventVarsDispatch({
      type: "SET_SCALE_FACTOR",
      payload: DEFAULT_SCALE_FACTOR,
    });

    setState({
      pipelineOffset: [
        INITIAL_PIPELINE_POSITION[0],
        INITIAL_PIPELINE_POSITION[1],
      ],
      pipelineStepsHolderOffsetLeft: 0,
      pipelineStepsHolderOffsetTop: 0,
    });
  };

  const centerPipelineOrigin = () => {
    if (!pipelineStepsOuterHolder.current) {
      console.error("PipelineStepsOuterHolder is not yet instantiated!");
      return;
    }
    let pipelineStepsOuterHolderEl = $(pipelineStepsOuterHolder.current);

    let pipelineStepsOuterHolderOffset = pipelineStepsOuterHolderEl.offset();

    let pipelineStepsHolderOffset = $(pipelineStepsHolder.current).offset();

    let centerOrigin = [
      scaleCorrectedPosition(
        pipelineStepsOuterHolderOffset.left -
          pipelineStepsHolderOffset.left +
          pipelineStepsOuterHolderEl.width() / 2,
        eventVars.scaleFactor
      ),
      scaleCorrectedPosition(
        pipelineStepsOuterHolderOffset.top -
          pipelineStepsHolderOffset.top +
          pipelineStepsOuterHolderEl.height() / 2,
        eventVars.scaleFactor
      ),
    ] as [number, number];

    pipelineSetHolderOrigin(centerOrigin);
  };

  const zoomOut = () => {
    centerPipelineOrigin();
    eventVarsDispatch({
      type: "SET_SCALE_FACTOR",
      payload: Math.max(eventVars.scaleFactor - 0.25, 0.25),
    });
  };

  const zoomIn = () => {
    centerPipelineOrigin();
    eventVarsDispatch({
      type: "SET_SCALE_FACTOR",
      payload: Math.min(eventVars.scaleFactor + 0.25, 2),
    });
  };

  const autoLayoutPipeline = () => {
    const spacingFactor = 0.7;
    const gridMargin = 20;

    const _pipelineJson = layoutPipeline(
      // Use the pipeline definition from the editor
      getPipelineJSON(),
      STEP_HEIGHT,
      (1 + spacingFactor * (STEP_HEIGHT / STEP_WIDTH)) *
        (STEP_WIDTH / STEP_HEIGHT),
      1 + spacingFactor,
      gridMargin,
      gridMargin * 4, // don't put steps behind top buttons
      gridMargin,
      STEP_HEIGHT
    );

    // TODO: make the step position state less duplicated.
    // Currently done for performance reasons.

    for (let stepUUID of Object.keys(_pipelineJson.steps)) {
      refManager.refs[stepUUID].updatePosition(
        _pipelineJson.steps[stepUUID].meta_data.position
      );
    }

    setPipelineJson(_pipelineJson);
    setPipelineSteps(_pipelineJson.steps);

    // and save
    setSaveHash(uuidv4());
  };

  const pipelineSetHolderOrigin = (newOrigin: [number, number]) => {
    if (!pipelineStepsHolder.current || !pipelineStepsOuterHolder.current) {
      console.error(
        "Unable to set the origin of pipelineStepsHolder. PipelineStepsHolder or pipelineStepsOuterHolder is not yet instantiated!"
      );
      return;
    }

    let holderOffset = $(pipelineStepsHolder.current).offset();
    let outerHolderOffset = $(pipelineStepsOuterHolder.current).offset();

    let initialX = holderOffset.left - outerHolderOffset.left;
    let initialY = holderOffset.top - outerHolderOffset.top;

    let [translateX, translateY] = originTransformScaling(
      [...newOrigin],
      eventVars.scaleFactor
    );

    setState(({ pipelineOffset }) => {
      const [pipelineOffsetX, pipelineOffsetY] = pipelineOffset;
      return {
        pipelineOrigin: newOrigin,
        pipelineStepsHolderOffsetLeft: translateX + initialX - pipelineOffsetX,
        pipelineStepsHolderOffsetTop: translateY + initialY - pipelineOffsetY,
      };
    });
  };

  const onPipelineStepsOuterHolderWheel = (e: React.WheelEvent) => {
    let pipelineMousePosition = getMousePositionRelativeToPipelineStepHolder();
    if (!pipelineMousePosition) return;

    // set origin at scroll wheel trigger
    if (
      pipelineMousePosition[0] !== state.pipelineOrigin[0] ||
      pipelineMousePosition[1] !== state.pipelineOrigin[1]
    ) {
      pipelineSetHolderOrigin(pipelineMousePosition);
    }

    /* mouseWheel contains information about the deltaY variable
     * WheelEvent.deltaMode can be:
     * DOM_DELTA_PIXEL = 0x00
     * DOM_DELTA_LINE = 0x01 (only used in Firefox)
     * DOM_DELTA_PAGE = 0x02 (which we'll treat identically to DOM_DELTA_LINE)
     */

    let deltaY =
      e.nativeEvent.deltaMode == 0x01 || e.nativeEvent.deltaMode == 0x02
        ? getScrollLineHeight() * e.nativeEvent.deltaY
        : e.nativeEvent.deltaY;

    eventVarsDispatch((current) => {
      return {
        type: "SET_SCALE_FACTOR",
        payload: Math.min(
          Math.max(current.scaleFactor - deltaY / 3000, 0.25),
          2
        ),
      };
    });
  };

  const runSelectedSteps = () => {
    runStepUUIDs(eventVars.selectedSteps, "selection");
  };
  const onRunIncoming = () => {
    runStepUUIDs(eventVars.selectedSteps, "incoming");
  };

  const cancelRun = async () => {
    if (isJobRun) {
      setConfirm(
        "Warning",
        "Are you sure that you want to cancel this job run?",
        async (resolve) => {
          setIsCancellingRun(true);
          try {
            await fetcher(
              `/catch/api-proxy/api/jobs/${jobUuidFromRoute}/${runUuid}`,
              {
                method: "DELETE",
              }
            );
            resolve(true);
          } catch (error) {
            setAlert("Error", `Failed to cancel this job run.`);
            resolve(false);
          }
          setIsCancellingRun(false);
          return true;
        }
      );
      return;
    }

    if (!pipelineRunning) {
      setAlert("Error", "There is no pipeline running.");
      return;
    }

    try {
      setIsCancellingRun(true);
      await fetcher(`${PIPELINE_RUN_STATUS_ENDPOINT}${runUuid}`, {
        method: "DELETE",
      });
      setIsCancellingRun(false);
    } catch (error) {
      setAlert("Error", `Could not cancel pipeline run for runUuid ${runUuid}`);
    }
  };

  const _runStepUUIDs = (uuids: string[], type: RunStepsType) => {
    setPipelineRunning(true);

    // store pipeline.json
    fetcher<PipelineRun>(PIPELINE_RUN_STATUS_ENDPOINT, {
      method: "POST",
      headers: HEADER.JSON,
      body: JSON.stringify({
        uuids: uuids,
        project_uuid: projectUuid,
        run_type: type,
        pipeline_definition: getPipelineJSON(),
      }),
    })
      .then((result) => {
        setStepExecutionState((current) => ({
          ...current,
          ...convertStepsToObject(result),
        }));
        setRunUuid(result.uuid);
      })
      .catch((response) => {
        setPipelineRunning(false);

        setAlert(
          "Error",
          `Failed to start interactive run. ${
            response.message || "Unknown error"
          }`
        );
      });
  };

  const runStepUUIDs = (uuids: string[], type: RunStepsType) => {
    if (!session || session.status !== "RUNNING") {
      setAlert(
        "Error",
        "There is no active session. Please start the session first."
      );
      return;
    }

    if (pipelineRunning) {
      setAlert(
        "Error",
        "The pipeline is currently executing, please wait until it completes."
      );
      return;
    }

    setSaveHash(uuidv4());
    setPendingRuns({ uuids, type });
  };

  const closeDetailsView = () => {
    eventVarsDispatch({ type: "SET_OPENED_STEP", payload: undefined });
  };

  const hasSelectedSteps = eventVars.selectedSteps?.length > 1;

  const onDetailsChangeView = (newIndex: number) => {
    setState({
      defaultDetailViewIndex: newIndex,
    });
  };

  const onSaveDetails = (
    stepChanges: Partial<Step>,
    uuid: string,
    replace: boolean
  ) => {
    eventVarsDispatch({
      type: "SAVE_STEP_DETAILS",
      payload: {
        stepChanges,
        uuid,
        replace,
      },
    });
    setSaveHash(uuidv4());
  };

  const deselectSteps = () => {
    eventVarsDispatch({ type: "DESELECT_STEPS" });
  };

  const deselectConnection = () => {
    eventVarsDispatch({ type: "DESELECT_CONNECTION" });
  };

  const getMousePositionRelativeToPipelineStepHolder = () => {
    if (!pipelineStepsHolder.current) {
      console.error(
        "Unable to get mouse position relative to pipelineStepsHolder. PipelineStepsHolder is not yet instantiated!"
      );
      return;
    }
    let { left, top } = $(pipelineStepsHolder.current).offset();

    return [
      scaleCorrectedPosition(mouseClient.x - left, eventVars.scaleFactor),
      scaleCorrectedPosition(mouseClient.y - top, eventVars.scaleFactor),
    ] as [number, number];
  };

  React.useLayoutEffect(() => {
    fetchPipelineAndInitialize();
    const keyDownHandler = (event: KeyboardEvent) => {
      if (event.key === " ") {
        $(pipelineStepsOuterHolder.current)
          .removeClass("dragging")
          .addClass("ready-to-drag");
        eventVarsDispatch({ type: "SET_KEYS_DOWN", payload: { 32: true } });
      }
    };
    const keyUpHandler = (event: KeyboardEvent) => {
      if (event.key === " ") {
        $(pipelineStepsOuterHolder.current).removeClass([
          "ready-to-drag",
          "dragging",
        ]);
        eventVarsDispatch({ type: "SET_KEYS_DOWN", payload: { 32: false } });
      }
    };

    document.body.addEventListener("keydown", keyDownHandler);
    document.body.addEventListener("keyup", keyUpHandler);
    return () => {
      document.body.removeEventListener("keydown", keyDownHandler);
      document.body.removeEventListener("keyup", keyUpHandler);
    };
  }, [eventVarsDispatch]);

  const enableHotKeys = () => {
    setScope("pipeline-editor");
    setIsHoverEditor(true);
  };

  const disableHotKeys = () => {
    setIsHoverEditor(false);
  };

  const onMouseDownStepsOuterHolder = (e: React.MouseEvent) => {
    const isLeftClick = e.button === 0;

    if (isLeftClick && eventVars.keysDown[32]) {
      // space held while clicking, means canvas drag
      $(pipelineStepsOuterHolder.current)
        .addClass("dragging")
        .removeClass("ready-to-drag");
      setDraggingCanvas(true);
    }

    const mouseClientX = e.clientX;
    const mouseClientY = e.clientY;
    setMouseClient({ x: e.clientX, y: e.clientY });
    const draggingCanvas = eventVars.keysDown[32]; // key down space
    // not dragging the canvas, so user must be creating a selection rectangle
    // we need to save the offset of cursor against pipeline steps holder
    const pipelineStepHolderOffset =
      isLeftClick && !draggingCanvas
        ? $(pipelineStepsHolder.current).offset()
        : null;

    if (isLeftClick && !draggingCanvas) {
      eventVarsDispatch({
        type: "ON_MOUSE_DOWN_CANVAS",
        payload: {
          mouseClientX,
          mouseClientY,
          pipelineStepHolderOffset,
        },
      });
    }
  };

  // TODO: check if these are actually working, we might need to use onMouseEnter onMouseLeave to assign event listeners
  const onMouseMoveStepsOuterHolder = (e: React.MouseEvent<HTMLDivElement>) => {
    if (eventVars.newConnection && pipelineStepsHolder.current) {
      let offset = $(pipelineStepsHolder.current).offset();

      eventVarsDispatch({
        type: "UPDATE_NEW_CONNECTION_END_NODE",
        payload: { mouseClientX: e.clientX, mouseClientY: e.clientY, offset },
      });
    }

    if (eventVars.stepSelector.active) {
      if (!pipelineStepsHolder.current) {
        console.error(
          "stepSelector is active, but pipelineStepsHolder is not yet instantiated!"
        );
        return;
      }

      let offset = $(pipelineStepsHolder.current).offset();

      eventVarsDispatch({
        type: "UPDATE_STEP_SELECTOR",
        payload: {
          offset,
          mouseClientX: e.clientY,
          mouseClientY: e.clientY,
        },
      });
    }

    if (eventVars.keysDown[32]) {
      let dx = e.clientX - mouseClient.x;
      let dy = e.clientY - mouseClient.y;

      setState((state) => {
        return {
          pipelineOffset: [
            state.pipelineOffset[0] + dx,
            state.pipelineOffset[1] + dy,
          ],
        };
      });
    }

    setMouseClient({ x: e.clientX, y: e.clientY });
  };

  const services = React.useMemo(() => {
    // not a job run, so it is an interactive run, services are only available if session is RUNNING
    if (!isJobRun && session?.status !== "RUNNING") return null;
    // it is a job run (non-interactive run), we are unable to check its actual session
    // but we can check its job run status,
    if (isJobRun && pipelineJson && !pipelineRunning) return null;
    const allServices = isJobRun
      ? pipelineJson?.services || {}
      : session && session.user_services
      ? session.user_services
      : {};
    // Filter services based on scope

    return filterServices(
      allServices,
      jobUuidFromRoute ? "noninteractive" : "interactive"
    );
  }, [pipelineJson, session, jobUuidFromRoute, isJobRun, pipelineRunning]);

  const returnToJob = (e?: React.MouseEvent) => {
    navigateTo(
      siteMap.job.path,
      {
        query: { projectUuid, jobUuid: jobUuidFromRoute },
      },
      e
    );
  };

  let connections_list = {};
  if (eventVars.openedStep) {
    const step = eventVars.steps[eventVars.openedStep];
    const { incoming_connections = [] } = step;

    incoming_connections.forEach((id: string) => {
      connections_list[id] = [
        eventVars.steps[id].title,
        eventVars.steps[id].file_path,
      ];
    });
  }

  // Check if there is an incoming step (that is not part of the
  // selection).
  // This is checked to conditionally render the
  // 'Run incoming steps' button.
  let selectedStepsHasIncoming = false;
  for (let x = 0; x < eventVars.selectedSteps.length; x++) {
    let selectedStep = eventVars.steps[eventVars.selectedSteps[x]];
    for (let i = 0; i < selectedStep.incoming_connections.length; i++) {
      let incomingStepUUID = selectedStep.incoming_connections[i];
      if (eventVars.selectedSteps.indexOf(incomingStepUUID) < 0) {
        selectedStepsHasIncoming = true;
        break;
      }
    }
    if (selectedStepsHasIncoming) {
      break;
    }
  }

  const pipelineSteps = Object.entries(eventVars.steps).map((entry) => {
    const [uuid, step] = entry;
    const selected = eventVars.selectedSteps.indexOf(uuid) !== -1;
    // only add steps to the component that have been properly
    // initialized
    return (
      <PipelineStep
        key={step.uuid}
        step={step}
        selected={selected}
        ref={(el) => (stepDomRefs.current[step.uuid] = el)}
        executionState={
          stepExecutionState
            ? stepExecutionState[step.uuid] || { status: "IDLE" }
            : { status: "IDLE" }
        }
        isCreatingConnection={hasValue(eventVars.newConnection)}
        isTrackingMouse={hasValue(eventVars.selectedSingleStep)}
        dispatchMouseEvent={eventVarsDispatch}
        onMouseUp={onMouseUpPipelineStep}
        onClick={onClickStepHandler}
        onDoubleClick={onDoubleClickStepHandler}
      />
    );
  });

  const connectionComponents = eventVars.connections.map(
    (connection, index) => {
      const { startNodeUUID, endNodeUUID } = connection;
      const startNode = stepDomRefs.current[startNodeUUID];
      const endNode = endNodeUUID ? stepDomRefs.current[endNodeUUID] : null;

      if (!pipelineStepsHolder.current || !startNode) return null;

      let startNodePosition = nodeCenter(
        startNode,
        pipelineStepsHolder.current,
        eventVars.scaleFactor
      );
      let endNodePosition = endNode
        ? nodeCenter(
            endNode,
            pipelineStepsHolder.current,
            eventVars.scaleFactor
          )
        : null;

      return (
        <PipelineConnection
          key={index}
          onClick={onClickConnection}
          startNodePosition={startNodePosition}
          endNodePosition={endNodePosition}
          {...connection}
        />
      );
    }
  );

  React.useEffect(() => {
    // TODO: running selected steps results in saving twice
    if (saveHash !== undefined) {
      if (pendingRuns) {
        const { uuids, type } = pendingRuns;
        setPendingRuns(undefined);
        savePipeline(() => {
          _runStepUUIDs(uuids, type);
        });
      } else {
        savePipeline();
      }
    }
  }, [saveHash, pendingRuns]);

  React.useEffect(() => {
    if (state.currentOngoingSaves === 0) {
      clearTimeout(timersRef.current.saveIndicatorTimeout);
      dispatch({
        type: "pipelineSetSaveStatus",
        payload: "saved",
      });
    }
  }, [state.currentOngoingSaves]);

  React.useEffect(() => {
    dispatch({
      type: "SET_PIPELINE_IS_READONLY",
      payload: isReadOnly,
    });
    const hasActiveRun = runUuid && jobUuidFromRoute;
    const isNonPipelineRun = !hasActiveRun && isReadOnly;
    if (isNonPipelineRun) {
      // for non pipelineRun - read only check gate
      let checkGatePromise = checkGate(projectUuid);
      checkGatePromise
        .then(() => {
          setIsReadOnly(false);
        })
        .catch((result) => {
          if (result.reason === "gate-failed") {
            requestBuild(projectUuid, result.data, "Pipeline", () => {
              setIsReadOnly(false);
            });
          }
        });
    }

    // Start with hotkeys disabled
    disableHotKeys();

    connectSocketIO();
    initializeResizeHandlers();

    // Edit mode fetches latest interactive run
    if (!isReadOnly) {
      fetchActivePipelineRuns();
    }

    return () => {
      disconnectSocketIO();

      $(document).off("mouseup.initializePipeline");
      $(document).off("mousedown.initializePipeline");
      $(document).off("keyup.initializePipeline");
      $(document).off("keydown.initializePipeline");

      clearTimeout(timersRef.current.doubleClickTimeout);
      clearTimeout(timersRef.current.saveIndicatorTimeout);

      disableHotKeys();

      promiseManager.cancelCancelablePromises();
    };
  }, []);

  React.useEffect(() => {
    if (
      state.pipelineOffset[0] == INITIAL_PIPELINE_POSITION[0] &&
      state.pipelineOffset[1] == INITIAL_PIPELINE_POSITION[1] &&
      eventVars.scaleFactor == DEFAULT_SCALE_FACTOR
    ) {
      pipelineSetHolderOrigin([0, 0]);
    }
  }, [eventVars.scaleFactor, state.pipelineOffset]);

  const servicesButtonRef = React.useRef<HTMLButtonElement>();

  return (
    <Layout disablePadding>
      <div className="pipeline-view">
        <div
          className="pane pipeline-view-pane"
          onMouseOver={enableHotKeys}
          onMouseLeave={disableHotKeys}
        >
          {jobUuidFromRoute && isReadOnly && (
            <div className="pipeline-actions top-left">
              <StyledButtonOutlined
                variant="outlined"
                color="secondary"
                sx={{
                  backgroundColor: (theme) => theme.palette.background.default,
                  borderColor: (theme) =>
                    darken(theme.palette.background.default, 0.2),
                  "&:hover": {
                    backgroundColor: (theme) =>
                      darken(theme.palette.background.default, 0.1),
                    borderColor: (theme) =>
                      darken(theme.palette.background.default, 0.3),
                  },
                }}
                startIcon={<ArrowBackIcon />}
                onClick={returnToJob}
                onAuxClick={returnToJob}
                data-test-id="pipeline-back-to-job"
              >
                Back to job
              </StyledButtonOutlined>
            </div>
          )}

          <div className="pipeline-actions bottom-left">
            <div className="navigation-buttons">
              <IconButton
                title="Center"
                data-test-id="pipeline-center"
                onClick={centerView}
              >
                <CropFreeIcon />
              </IconButton>
              <IconButton title="Zoom out" onClick={zoomOut}>
                <RemoveIcon />
              </IconButton>
              <IconButton title="Zoom in" onClick={zoomIn}>
                <AddIcon />
              </IconButton>
              <IconButton title="Auto layout" onClick={autoLayoutPipeline}>
                <AccountTreeOutlinedIcon />
              </IconButton>
            </div>

            {!isReadOnly &&
              !pipelineRunning &&
              eventVars.selectedSteps.length > 0 &&
              !eventVars.stepSelector.active && (
                <div className="selection-buttons">
                  <Button
                    variant="contained"
                    onClick={runSelectedSteps}
                    data-test-id="interactive-run-run-selected-steps"
                  >
                    Run selected steps
                  </Button>
                  {selectedStepsHasIncoming && (
                    <Button
                      variant="contained"
                      onClick={onRunIncoming}
                      data-test-id="interactive-run-run-incoming-steps"
                    >
                      Run incoming steps
                    </Button>
                  )}
                </div>
              )}
            {pipelineRunning && (
              <div className="selection-buttons">
                <Button
                  variant="contained"
                  color="secondary"
                  onClick={cancelRun}
                  startIcon={<CloseIcon />}
                  disabled={isCancellingRun}
                  data-test-id="interactive-run-cancel"
                >
                  Cancel run
                </Button>
              </div>
            )}
          </div>

          {pipelineJson && (
            <div className={"pipeline-actions top-right"}>
              {!isReadOnly && (
                <Button
                  variant="contained"
                  color="secondary"
                  onClick={createNextStep}
                  startIcon={<AddIcon />}
                  data-test-id="step-create"
                >
                  NEW STEP
                </Button>
              )}

              {isReadOnly && (
                <Button
                  color="secondary"
                  startIcon={<VisibilityIcon />}
                  disabled
                >
                  Read only
                </Button>
              )}

              <Button
                variant="contained"
                color="secondary"
                onClick={openLogs}
                onAuxClick={openLogs}
                startIcon={<ViewHeadlineIcon />}
              >
                Logs
              </Button>

              <Button
                id="running-services-button"
                variant="contained"
                color="secondary"
                onClick={showServices}
                startIcon={<SettingsIcon />}
                ref={servicesButtonRef}
              >
                Services
              </Button>
              <ServicesMenu
                isOpen={isShowingServices}
                onClose={hideServices}
                anchor={servicesButtonRef}
                services={services}
              />

              <Button
                variant="contained"
                color="secondary"
                onClick={openSettings}
                startIcon={<TuneIcon />}
                data-test-id="pipeline-settings"
              >
                Settings
              </Button>
            </div>
          )}

          <div
            className="pipeline-steps-outer-holder"
            ref={pipelineStepsOuterHolder}
            onMouseMove={onMouseMoveStepsOuterHolder}
            onMouseDown={onMouseDownStepsOuterHolder}
            onWheel={onPipelineStepsOuterHolderWheel}
          >
            <div
              className="pipeline-steps-holder"
              ref={pipelineStepsHolder}
              style={{
                transformOrigin: `${state.pipelineOrigin[0]}px ${state.pipelineOrigin[1]}px`,
                transform:
                  "translateX(" +
                  state.pipelineOffset[0] +
                  "px)" +
                  "translateY(" +
                  state.pipelineOffset[1] +
                  "px)" +
                  "scale(" +
                  eventVars.scaleFactor +
                  ")",
                left: state.pipelineStepsHolderOffsetLeft,
                top: state.pipelineStepsHolderOffsetTop,
              }}
            >
              {eventVars.stepSelector.active && (
                <Rectangle
                  {...getStepSelectorRectangle(eventVars.stepSelector)}
                />
              )}
              {pipelineSteps}
              <div className="connections">{connectionComponents}</div>
            </div>
          </div>
        </div>

        {eventVars.openedStep && (
          <PipelineDetails
            key={eventVars.openedStep}
            onSave={onSaveDetails}
            onDelete={onDetailsDelete}
            onClose={closeDetailsView}
            onOpenFilePreviewView={onOpenFilePreviewView}
            onOpenNotebook={onOpenNotebook}
            onChangeView={onDetailsChangeView}
            connections={connections_list}
            defaultViewIndex={state.defaultDetailViewIndex}
            pipeline={pipelineJson}
            pipelineCwd={pipelineCwd}
            project_uuid={projectUuid}
            job_uuid={jobUuidFromRoute}
            run_uuid={runUuid}
            sio={state.sio}
            readOnly={isReadOnly}
            step={eventVars.steps[eventVars.openedStep]}
            saveHash={saveHash}
          />
        )}

        {hasSelectedSteps && !isReadOnly && (
          <div className={"pipeline-actions bottom-right"}>
            <Button
              variant="contained"
              color="secondary"
              onClick={deleteSelectedSteps}
              startIcon={<DeleteIcon />}
              disabled={isDeletingSteps}
              data-test-id="step-delete-multi"
            >
              Delete
            </Button>
          </div>
        )}
      </div>
    </Layout>
  );
};

export default PipelineView;
