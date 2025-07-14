import {
  cancel,
  confirm,
  init,
  onCancelRouter,
  on_confirm,
  onInit,
  onSearch,
  onSelect,
  onStatusRouter,
  search,
  select,
  checkStatus,
  track,
  on_track,
  onUpdateRouter,
  updateRouter,
} from "./apiTests";

import { validationOutput } from "./types";

export async function performL1CustomValidations(
  payload: any,
  action: string,
  allErrors = false,
  externalData = {}
): Promise<validationOutput> {
  console.log("Performing custom L1 validations for action: " + action);
  let result: any = [];
  switch (action) {
    case "search":
      result = await search(payload);
      break;
    case "on_search":
      result = await onSearch(payload);
      break;
    case "select":
      result = await select(payload);
      break;
    case "on_select":
      result = await onSelect(payload);
      break;
    case "init":
      result = await init(payload);
      break;
    case "on_init":
      result = await onInit(payload);
      break;
    case "confirm":
      result = await confirm(payload);
      break;
    case "on_confirm":
      result = await on_confirm(payload);
      break;
    case "status":
      result = await checkStatus(payload);
      break;
    case "on_status":
      result = await onStatusRouter(payload);
      break;
    case "track":
      result = await track(payload);
      break;
    case "on_track":
      result = await on_track(payload);
      break;
    case "cancel":
      result = await cancel(payload);
      break;
    case "on_cancel":
      result = await onCancelRouter(payload);
      break;
    case "update":
      result = await updateRouter(payload);
      break;
    case "on_update":
      result = await onUpdateRouter(payload);
      break;
    default:
      result = [
        {
          valid: false,
          code: 403,
          description: "Not a valid action call",
        },
      ];

      break;
  }
  return [...result];
}
