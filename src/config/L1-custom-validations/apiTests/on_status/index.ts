import { RedisService } from "ondc-automation-cache-lib";
import checkOnStatusDelivered from "./on_status_delivered";
import checkOnStatusOutForDelivery from "./on_status_out_for_delivery";
import checkOnStatusPacked from "./on_status_packed";
import checkOnStatusAgentAssigned from "./on_status_agent_assigned";
import checkOnStatusPending from "./on_status_pending";
import checkOnStatusPicked from "./on_status_picked";
import checkOnStatusRTODelivered from "./on_status_rto_delivered";
import _ from "lodash";

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

  switch (state) {
    case "Pending":
      result = await checkOnStatusPending(data, state, fulfillmentsItemsSet);
      break;
    case "Packed":
      result = await checkOnStatusPacked(data, state, fulfillmentsItemsSet);
      break;
    case "Agent-assigned":
      result = await checkOnStatusAgentAssigned(
        data,
        state,
        fulfillmentsItemsSet
      );
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
