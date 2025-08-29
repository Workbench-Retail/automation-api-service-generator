import { RedisService } from "ondc-automation-cache-lib";
import _ from "lodash";
import { ApiSequence } from "../../utils//constants";
import { checkUpdate } from "./update";
import { checkOnUpdate } from "./on_update";

interface ValidationError {
  valid: boolean;
  code: number;
  description: string;
}

const addError = (code: number, description: string): ValidationError => ({
  valid: false,
  code,
  description,
});

async function fetchRedisSet(
  transaction_id: string,
  key: string
): Promise<Set<any>> {
  try {
    const rawData = await RedisService.getKey(`${transaction_id}_${key}`);
    return new Set(rawData ? JSON.parse(rawData) : []);
  } catch (error: any) {
    console.error(
      `Error fetching Redis key ${transaction_id}_${key}: ${error.stack}`
    );
    return new Set();
  }
}

export const updateRouter = async (data: any) => {
  const transaction_id = data.context.transaction_id;
  let apiSeq = "update";
  let result: any = [];

  // Fetch settlement details set
  let settlementDetailSet = await fetchRedisSet(
    transaction_id,
    "settlementDetailSet"
  );

  const updateTarget = data?.message?.update_target;
  if (updateTarget) {
    if (updateTarget === "payment") {
      result = await checkUpdate(data, settlementDetailSet, apiSeq, "payment");
    } else if (updateTarget === "item") {
      result = await checkUpdate(data, settlementDetailSet, "update", "item");
    } else {
      result = [
        addError(400, "Invalid action call, update_target is not correct"),
      ];
    }
  } else {
    result = [addError(400, "Invalid action call, update_target is misisng")];
  }

  return result;
};

export const onUpdateRouter = async (data: any) => {
  const transaction_id = data.context.transaction_id;
  let result: any = [];
  let apiSeq = "";
  let flow = "";

  // Fetch Redis sets concurrently
  const [fulfillmentsItemsSet, settlementDetailSet, quoteTrailItemsSet] =
    await Promise.all([
      fetchRedisSet(transaction_id, "fulfillmentsItemsSet"),
      fetchRedisSet(transaction_id, "settlementDetailSet"),
      fetchRedisSet(transaction_id, "quoteTrailItemsSet"),
    ]);

  const fulfillments = data.message?.order?.fulfillments;
  const length = fulfillments?.length;

  if (!fulfillments || !length) {
    return [addError(400, "Fulfillments are missing or empty")];
  }

  let fulfillmentObj = fulfillments[length - 1];
  const returnRequestObj = fulfillments.find((f: any) => f.type === "Return");

  if (returnRequestObj) {
    fulfillmentObj = returnRequestObj;
  }

  const fulfillmentType = fulfillmentObj.type;
  if (fulfillmentType === "Cancel") {
    apiSeq = ApiSequence.ON_UPDATE_PART_CANCEL;
    flow = "6-a";
  } else {
    const fulfillmentState = fulfillmentObj.state?.descriptor?.code;
    flow = "6-b";
    switch (fulfillmentState) {
      case "Return_Initiated":
        apiSeq = ApiSequence.ON_UPDATE_INTERIM;
        break;
      case "Return_Approved":
        apiSeq = ApiSequence.ON_UPDATE_APPROVAL;
        break;
      case "Return_Picked":
        apiSeq = ApiSequence.ON_UPDATE_PICKED;
        break;
      case "Return_Delivered":
        apiSeq = ApiSequence.ON_UPDATE_DELIVERED;
        break;
      default:
        flow = "6";
        apiSeq = ApiSequence.ON_UPDATE;
        break;
    }
  }

  if (result.length === 0) {
    result = await checkOnUpdate(
      data,
      apiSeq,
      settlementDetailSet,
      quoteTrailItemsSet,
      fulfillmentsItemsSet,
      flow,
      transaction_id
    );
  }

  return result;
};

