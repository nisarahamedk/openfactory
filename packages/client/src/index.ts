export { FactoryApi, FactoryApiError, type FactoryApiConfig } from "./api.js";
// The API's shapes live in @openfactory/contract; re-exported so existing imports keep working.
export { ApiError, CancelTask, RetryTask, ApproveTask, HealthReport, EgressReport, FactoryInfo, FactoryView, NewTaskRequest, PostMessage, SaveView, SetRollout, StartBenchRun, SetOrg, ConnectOrgRepo, InvitePerson, SaveOrgTeam, SaveOrgFactory, ConnectOrgSource, buildOpenApi } from "@openfactory/contract";
