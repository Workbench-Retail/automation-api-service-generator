import constants, { ApiSequence } from "../../utils/constants";
import { addActionToRedisSet } from "../../utils/helper";
import { onCancel } from "./on_cancel";

export const onCancelRouter = async (data: any) => {
  let result: any = [];
  let actionCall = `${ApiSequence.ON_CANCEL}`;
  try {
    const onStatusPresent = await addActionToRedisSet(
      data.context.transaction_id,
      ApiSequence.ON_STATUS_OUT_FOR_DELIVERY,
      ApiSequence.ON_CANCEL_RTO
    );
    if (onStatusPresent) {
      actionCall = `${ApiSequence.ON_CANCEL_RTO}`;
    }
  } catch (error: any) {
    console.error(
      `!!Error while previous action call /${constants.ON_CANCEL}, ${error.stack}`
    );
  }

  switch (actionCall) {
    case `${ApiSequence.ON_CANCEL}`:
      result = await onCancel(data, "4");
      break;
    case `${ApiSequence.ON_CANCEL_RTO}`:
      result = await onCancel(data, "5");
      break;
    default:
      result = [
        {
          valid: false,
          code: 400,
          description: `Invalid on_cancel call`,
        },
      ];
      break;
  }
  return result;
};
