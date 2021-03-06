import os
from enum import Enum

ORCHEST_NAMESPACE = "orchest"
ORCHEST_VERSION = os.environ["ORCHEST_VERSION"]

STATUS_CHANGING_OPERATIONS = [
    "install",
    "start",
    "stop",
    "restart",
    "update",
    "uninstall",
]


class OrchestStatus(str, Enum):
    INSTALLING = "installing"
    RESTARTING = "restarting"
    RUNNING = "running"
    STARTING = "starting"
    STOPPED = "stopped"
    STOPPING = "stopping"
    UNHEALTHY = "unhealthy"
    UNINSTALLING = "uninstalling"
    UPDATING = "updating"


ORCHEST_OPERATION_TO_STATUS_MAPPING = {
    "install": OrchestStatus.INSTALLING,
    "start": OrchestStatus.STARTING,
    "stop": OrchestStatus.STOPPING,
    "restart": OrchestStatus.RESTARTING,
    "update": OrchestStatus.UPDATING,
}


ORCHEST_DEPLOYMENTS = [
    "auth-server",
    "celery-worker",
    "docker-registry",
    "orchest-api",
    "orchest-database",
    "orchest-webserver",
    "rabbitmq-server",
    "argo-workflow-argo-workflows-server",
    "argo-workflow-argo-workflows-workflow-controller",
]

DEPLOYMENT_VERSION_SYNCED_WITH_CLUSTER_VERSION = [
    "auth-server",
    "celery-worker",
    "orchest-api",
    "orchest-webserver",
]

DEPLOYMENTS_WITH_ORCHEST_LOG_LEVEL_ENV_VAR = [
    "auth-server",
    "celery-worker",
    "orchest-api",
    "orchest-webserver",
]

DEPLOYMENTS_WITH_CLOUD_ENV_VAR = [
    "auth-server",
    "orchest-webserver",
]

for depl in (
    DEPLOYMENTS_WITH_ORCHEST_LOG_LEVEL_ENV_VAR
    + DEPLOYMENTS_WITH_CLOUD_ENV_VAR
    + DEPLOYMENT_VERSION_SYNCED_WITH_CLUSTER_VERSION
):
    assert depl in ORCHEST_DEPLOYMENTS

ORCHEST_DAEMONSETS = ["node-agent"]

DAEMONSET_SCALING_FLAG = "ORCHEST-RESERVED-DAEMONSET-SCALING-FLAG"

WRAP_LINES = 72
# Used to avoid outputting anything that isn't the desired json.
JSON_MODE = False

ORCHEST_CTL_POD_YAML_PATH = "/orchest/deploy/orchest-ctl/pod.yml"
