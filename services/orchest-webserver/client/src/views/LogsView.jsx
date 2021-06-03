// @ts-check
import React from "react";
import PipelineView from "./PipelineView";
import LogViewer from "../components/LogViewer";
import {
  makeRequest,
  PromiseManager,
  makeCancelable,
} from "@orchest/lib-utils";

import io from "socket.io-client";
import {
  MDCButtonReact,
  MDCLinearProgressReact,
  MDCDrawerReact,
} from "@orchest/lib-mdc";
import { useOrchest, OrchestSessionsConsumer } from "@/hooks/orchest";
import {
  getPipelineJSONEndpoint,
  createOutgoingConnections,
} from "../utils/webserver-utils";

const LogsView = (props) => {
  const orchest = window.orchest;
  const { state, dispatch, get } = useOrchest();
  const promiseManager = new PromiseManager();

  const [selectedLog, setSelectedLog] = React.useState(undefined);
  const [logType, setLogType] = React.useState(undefined);
  const [sortedSteps, setSortedSteps] = React.useState(undefined);
  const [pipelineJson, setPipelineJson] = React.useState(undefined);
  const [sio, setSio] = React.useState(undefined);
  const [job, setJob] = React.useState(undefined);

  // Conditional fetch session
  let session;
  if (!props.queryArgs.job_uuid) {
    session = get.session(props.queryArgs);
  }

  React.useEffect(() => {
    connectSocketIO();
    fetchPipeline();

    if (props.queryArgs.job_uuid) {
      fetchJob();
    }

    return () => {
      promiseManager.cancelCancelablePromises();
      disconnectSocketIO();
    };
  }, []);

  const connectSocketIO = () => {
    // disable polling
    let socket = io.connect("/pty", { transports: ["websocket"] });

    socket.on("connect", () => {
      setSio(socket);
    });
  };

  const disconnectSocketIO = () => {
    if (sio) {
      sio.disconnect();
    }
  };

  const topologicalSort = (pipelineSteps) => {
    let sortedStepKeys = [];

    pipelineSteps = createOutgoingConnections(pipelineSteps);

    let conditionalAdd = (step) => {
      // add iff all parents are already in the sortedStepKeys
      let parentsAdded = true;
      for (let x = 0; x < step.incoming_connections.length; x++) {
        if (sortedStepKeys.indexOf(step.incoming_connections[x]) == -1) {
          parentsAdded = false;
          break;
        }
      }

      if (sortedStepKeys.indexOf(step.uuid) == -1 && parentsAdded) {
        sortedStepKeys.push(step.uuid);
      }
    };

    // Add self and children (breadth first)
    let addSelfAndChildren = (step) => {
      conditionalAdd(step);

      for (let x = 0; x < step.outgoing_connections.length; x++) {
        let childStepUUID = step.outgoing_connections[x];
        let childStep = pipelineSteps[childStepUUID];

        conditionalAdd(childStep);
      }

      // Recurse down
      for (let x = 0; x < step.outgoing_connections.length; x++) {
        let childStepUUID = step.outgoing_connections[x];
        addSelfAndChildren(pipelineSteps[childStepUUID]);
      }
    };

    // Find roots
    for (let stepUUID in pipelineSteps) {
      let step = pipelineSteps[stepUUID];
      if (step.incoming_connections.length == 0) {
        addSelfAndChildren(step);
      }
    }

    return sortedStepKeys.map((stepUUID) => pipelineSteps[stepUUID]);
  };

  const setHeaderComponent = (pipelineName) => {
    dispatch({
      type: "pipelineSet",
      payload: {
        pipeline_uuid: props.queryArgs.pipeline_uuid,
        project_uuid: props.queryArgs.project_uuid,
        pipelineName: pipelineName,
      },
    });
  };

  const generateServiceItems = (job) => {
    let serviceItems = [];
    let services;

    // If there is no job_uuid use the session for
    // fetch the services
    if (
      props.queryArgs.job_uuid == undefined &&
      session &&
      session.user_services
    ) {
      services = session.user_services;
    }
    // if there is a job_uuid use the job pipeline to
    // fetch the services.
    else if (job.pipeline_definition.services !== undefined) {
      services = job.pipeline_definition.services;
    }

    if (services) {
      for (let key of Object.keys(services)) {
        let service = services[key];

        serviceItems.push({
          type: "service",
          identifier: service.name,
          label: (
            <>
              <span className="log-title">{service.name}</span>
              <br />
              <span>{service.image}</span>
            </>
          ),
        });
      }
    }

    return serviceItems;
  };

  const fetchPipeline = () => {
    let pipelineJSONEndpoint = getPipelineJSONEndpoint(
      props.queryArgs.pipeline_uuid,
      props.queryArgs.project_uuid,
      props.queryArgs.job_uuid,
      props.queryArgs.run_uuid
    );

    let pipelinePromise = makeCancelable(
      makeRequest("GET", pipelineJSONEndpoint),
      promiseManager
    );

    pipelinePromise.promise.then((response) => {
      let result = JSON.parse(response);

      if (result.success) {
        let pipelineJson = JSON.parse(result["pipeline_json"]);
        setPipelineJson(pipelineJson);

        let sortedSteps = topologicalSort(pipelineJson.steps);
        setSortedSteps(sortedSteps);
        setHeaderComponent(pipelineJson.name);

        // set first step as selectedLog
        if (sortedSteps.length > 0) {
          setSelectedLog(sortedSteps[0].uuid);
          setLogType("step");
        }
      } else {
        console.warn("Could not load pipeline.json");
        console.log(result);
      }
    });
  };

  const fetchJob = () => {
    makeRequest(
      "GET",
      `/catch/api-proxy/api/jobs/${props.queryArgs.job_uuid}`
    ).then(
      /** @param {string} response */
      (response) => {
        try {
          setJob(JSON.parse(response));
        } catch (error) {
          console.error("Failed to fetch job.", error);
        }
      }
    );
  };

  const hasLoaded = () => {
    return (
      pipelineJson &&
      sortedSteps &&
      sio &&
      logType &&
      selectedLog &&
      (props.queryArgs.job_uuid === undefined || job)
    );
  };

  const close = () => {
    orchest.loadView(PipelineView, {
      queryArgs: {
        pipeline_uuid: props.queryArgs.pipeline_uuid,
        project_uuid: props.queryArgs.project_uuid,
        read_only: props.queryArgs.read_only,
        job_uuid: props.queryArgs.job_uuid,
        run_uuid: props.queryArgs.run_uuid,
      },
    });
  };

  const clickLog = (_, item) => {
    setSelectedLog(item.identifier);
    setLogType(item.type);
  };

  let rootView = undefined;

  if (hasLoaded()) {
    let steps = [];

    for (let step of sortedSteps) {
      steps.push({
        identifier: step.uuid,
        type: "step",
        label: (
          <>
            <span className="log-title">{step.title}</span>
            <br />
            <span>{step.file_path}</span>
          </>
        ),
      });
    }

    let dynamicLogViewerProps = {};
    if (logType == "step") {
      dynamicLogViewerProps["step_uuid"] = selectedLog;
    } else if (logType == "service") {
      dynamicLogViewerProps["service_name"] = selectedLog;
    }

    rootView = (
      <div className="logs">
        <div className="log-selector">
          <div className="log-section">
            <i className="material-icons">device_hub</i>
            Step logs
          </div>
          <MDCDrawerReact
            items={steps}
            selectedIndex={logType == "step" ? undefined : -1}
            action={clickLog}
          />
          <div role="separator" className="mdc-list-divider" />
          <div className="log-section">
            <i className="material-icons">settings</i>
            Service logs
          </div>
          <MDCDrawerReact
            items={generateServiceItems(job)}
            selectedIndex={logType == "service" ? undefined : -1}
            action={clickLog}
          />
        </div>
        <div className="logs-xterm-holder">
          {selectedLog && (
            <LogViewer
              key={selectedLog}
              sio={sio}
              pipeline_uuid={props.queryArgs.pipeline_uuid}
              project_uuid={props.queryArgs.project_uuid}
              job_uuid={props.queryArgs.job_uuid}
              run_uuid={props.queryArgs.run_uuid}
              {...dynamicLogViewerProps}
            />
          )}
        </div>

        <div className="top-buttons">
          <MDCButtonReact
            classNames={["close-button"]}
            icon="close"
            onClick={close}
          />
        </div>
      </div>
    );
  } else {
    rootView = <MDCLinearProgressReact />;
  }

  return (
    <OrchestSessionsConsumer>
      <div className="view-page no-padding logs-view">{rootView}</div>
    </OrchestSessionsConsumer>
  );
};

export default LogsView;
