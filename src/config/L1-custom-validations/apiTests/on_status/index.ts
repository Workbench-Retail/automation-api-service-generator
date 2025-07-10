import { RedisService } from "ondc-automation-cache-lib";
import checkOnStatusDelivered from "./on_status_delivered";
import checkOnStatusOutForDelivery from "./on_status_out_for_delivery";
import checkOnStatusPacked from "./on_status_packed";
import checkOnStatusPending from "./on_status_pending";
import checkOnStatusPicked from "./on_status_picked";
import checkOnStatusRTODelivered from "./on_status_rto_delivered";
import checkOnStatus from "./on_status";
import _ from "lodash";
import checkOnStatusAgentAssigned from "./ on_status_agent_assigned";

export const onStatusRouter = async (data: any) => {
  const fulfillments = data?.message?.order?.fulfillments;
  const deliveryFulfillment = fulfillments.find(
    (ff: any) => ff.type === "Delivery"
  );
  const rtoFulfillment = fulfillments.find((ff: any) => ff.type === "RTO");
  let state = "";
  let returnState = "";
  if (!_.isEmpty(rtoFulfillment)) {
    state = rtoFulfillment?.state?.descriptor?.code;
  } else {
    state = deliveryFulfillment?.state?.descriptor?.code;
  }
  const transaction_id = data?.context?.transaction_id;
  let result: any = [];
  let fulfillmentsItemsSetRaw: any = await RedisService.getKey(
    `${transaction_id}_fulfillmentsItemsSet`
  );
  let fulfillmentsItemsSet = new Set(
    fulfillmentsItemsSetRaw ? JSON.parse(fulfillmentsItemsSetRaw) : []
  );

  const returnFulfillmentArr = fulfillments.filter(
    (ff: any) => ff.type === "Return"
  );

  const deliveryFulfillmentArr = fulfillments.filter(
    (ff: any) => ff.type === "Delivery"
  );

  if (returnFulfillmentArr.length > 0 && deliveryFulfillmentArr.length > 1) {
    state = "Return";
    const replaceId = await RedisService.getKey(
      `${data.context.transaction_id}_replaceId`
    );
    const deliveryObj = deliveryFulfillmentArr.find((ff: any) => {
      return ff.type == "Delivery" && ff.id === replaceId;
    });

    if (deliveryObj) {
      returnState = deliveryObj.state?.descriptor?.code;
    }
  }

  switch (state) {
    case "Pending":
      result = await checkOnStatusPending(data, state, fulfillmentsItemsSet);
      break;
    case "Packed":
      result = await checkOnStatusPacked(data, state, fulfillmentsItemsSet);
      break;
    case "Agent-assigned":
      result = await checkOnStatusAgentAssigned(data, state, fulfillmentsItemsSet);
      break;
    case "Order-picked-up":
      result = await checkOnStatusPicked(data, state, fulfillmentsItemsSet);
      break;
    case "Out-for-delivery":
      result = await checkOnStatusOutForDelivery(
        data,
        state,
        fulfillmentsItemsSet
      );
      break;
    case "Order-delivered":
      result = await checkOnStatusDelivered(data, state, fulfillmentsItemsSet);
      break;
    case "RTO-Disposed":
    case "RTO-Delivered":
      result = await checkOnStatusRTODelivered(data);
      break;
    case "Return":
      result = await checkOnStatus(data, returnState, fulfillmentsItemsSet);
      break;
    case "RTO-Initiated":
      result = await checkOnStatus(data, state, fulfillmentsItemsSet);
      break;
    default:
      result = [
        {
          valid: false,
          code: 400,
          description: `Invalid on_status state: ${state}`,
        },
      ];
      break;
  }
  return result;
};
