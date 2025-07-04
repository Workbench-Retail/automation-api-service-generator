/* eslint-disable no-prototype-builtins */
import _ from "lodash";
import { RedisService } from "ondc-automation-cache-lib";
import constants, { ApiSequence } from "../../utils/constants";
import {
  isObjectEmpty,
  checkContext,
  checkBppIdOrBapId,
  compareObjects,
  sumQuoteBreakUp,
  payment_status,
  mapCancellationID,
  checkQuoteTrail,
  checkQuoteTrailSum,
  compareFulfillmentObject,
} from "../../utils/helper";

// Minimal interface for validation error
interface ValidationError {
  valid: boolean;
  code: number;
  description: string;
}

// Error codes based on provided table
const ERROR_CODES = {
  INVALID_RESPONSE: 20006, // Invalid response (API contract violations)
  INVALID_ORDER_STATE: 20007, // Invalid or stale order/fulfillment state
  OUT_OF_SEQUENCE: 20008, // Callback out of sequence
  TIMEOUT: 20009, // Callback received late
  INTERNAL_ERROR: 23001, // Internal processing error (retryable)
  ORDER_VALIDATION_FAILURE: 23002, // Order validation failed
  CANCELLATION_INVALID_REASON: 22502, // Cancellation unacceptable - Invalid cancellation reason
  CANCELLATION_QUOTE_MISMATCH: 22503, // Cancellation unacceptable - Quote does not match original order value
  INVALID_FULFILLMENT_TAT: 22504, // Invalid Fulfillment TAT - Fulfillment turnaround time differs from quoted
};

const TTL_IN_SECONDS: number = Number(process.env.TTL_IN_SECONDS) || 3600;

// Utility function to create error objects
const addError = (description: string, code: number): ValidationError => ({
  valid: false,
  code,
  description,
});

async function validateContext(
  context: any,
  transaction_id: string,
  result: ValidationError[]
): Promise<void> {
  try {
    console.info(
      `Checking context for /${constants.ON_STATUS_RTO_DELIVERED} API`
    );
    const contextRes = checkContext(context, constants.ON_STATUS);
    if (!contextRes?.valid) {
      const errors = contextRes?.ERRORS;
      Object.keys(errors).forEach((key: string) =>
        result.push(addError(errors[key], ERROR_CODES.INVALID_RESPONSE))
      );
    }

    if (checkBppIdOrBapId(context.bap_id)) {
      result.push(
        addError(
          "context/bap_id should not be a url",
          ERROR_CODES.INVALID_RESPONSE
        )
      );
    }
    if (checkBppIdOrBapId(context.bpp_id)) {
      result.push(
        addError(
          "context/bpp_id should not be a url",
          ERROR_CODES.INVALID_RESPONSE
        )
      );
    }

    const searchContextRaw = await RedisService.getKey(
      `${transaction_id}_${ApiSequence.SEARCH}_context`
    );
    const searchContext = searchContextRaw
      ? JSON.parse(searchContextRaw)
      : null;
    if (searchContext && !_.isEqual(searchContext.city, context.city)) {
      result.push(
        addError(
          `City code mismatch in /${constants.SEARCH} and /${constants.ON_STATUS_RTO_DELIVERED}`,
          ERROR_CODES.INVALID_RESPONSE
        )
      );
    }

    const selectRaw = await RedisService.getKey(
      `${transaction_id}_${ApiSequence.SELECT}`
    );
    const select = selectRaw ? JSON.parse(selectRaw) : null;
    if (
      select &&
      !_.isEqual(select.context.transaction_id, context.transaction_id)
    ) {
      result.push(
        addError(
          `Transaction Id should be same from /${constants.SELECT} onwards`,
          ERROR_CODES.INVALID_RESPONSE
        )
      );
    }
  } catch (error: any) {
    console.error(
      `!!Error while checking context for /${constants.ON_STATUS_RTO_DELIVERED}, ${error.stack}`
    );
    result.push(
      addError(
        "Internal error while checking context",
        ERROR_CODES.INTERNAL_ERROR
      )
    );
  }
}

async function validateTimestamps(
  context: any,
  transaction_id: string,
  result: ValidationError[]
): Promise<void> {
  try {
    const onInitTmpstmpRaw = await RedisService.getKey(
      `${transaction_id}_${ApiSequence.ON_INIT}_tmpstmp`
    );
    const onInitTmpstmp = onInitTmpstmpRaw
      ? JSON.parse(onInitTmpstmpRaw)
      : null;
    if (onInitTmpstmp && _.gte(onInitTmpstmp, context.timestamp)) {
      result.push(
        addError(
          `Timestamp for /${constants.ON_INIT} api cannot be greater than or equal to /${constants.ON_STATUS_RTO_DELIVERED} api`,
          ERROR_CODES.OUT_OF_SEQUENCE
        )
      );
    }
  } catch (error: any) {
    console.error(
      `!!Error while comparing timestamp for /${constants.ON_INIT} and /${constants.ON_STATUS_RTO_DELIVERED}, ${error.stack}`
    );
    result.push(
      addError(
        "Internal error while checking timestamps",
        ERROR_CODES.INTERNAL_ERROR
      )
    );
  }
}

async function validateOrder(
  order: any,
  transaction_id: string,
  result: ValidationError[]
): Promise<void> {
  try {
    let cnfrmOrdrId =
      (await RedisService.getKey(`${transaction_id}_cnfrmOrdrId`)) || "";
    if (cnfrmOrdrId && order.id !== cnfrmOrdrId) {
      result.push(
        addError(
          `Order Id mismatches in /${constants.ON_STATUS_RTO_DELIVERED} and /${constants.ON_CONFIRM}`,
          ERROR_CODES.INVALID_RESPONSE
        )
      );
    }

    const providerIdRaw = await RedisService.getKey(
      `${transaction_id}_providerId`
    );
    const providerId = providerIdRaw ? JSON.parse(providerIdRaw) : null;
    if (providerId && order.provider?.id !== providerId) {
      result.push(
        addError(
          `Provider Id mismatches in /${constants.ON_SELECT} and /${constants.ON_STATUS_RTO_DELIVERED}`,
          ERROR_CODES.INVALID_RESPONSE
        )
      );
    }

    const providerLocRaw = await RedisService.getKey(
      `${transaction_id}_providerLoc`
    );
    const providerLoc = providerLocRaw ? JSON.parse(providerLocRaw) : null;
    if (providerLoc && order.provider?.locations?.[0]?.id !== providerLoc) {
      result.push(
        addError(
          `provider.locations[0].id mismatches in /${constants.ON_SEARCH} and /${constants.ON_STATUS_RTO_DELIVERED}`,
          ERROR_CODES.INVALID_RESPONSE
        )
      );
    }

    if (
      !order.hasOwnProperty("created_at") ||
      !order.hasOwnProperty("updated_at")
    ) {
      result.push(
        addError(
          `order created and updated timestamps are mandatory in /${constants.ON_STATUS_RTO_DELIVERED}`,
          ERROR_CODES.INVALID_RESPONSE
        )
      );
    } else if (!_.gt(order.updated_at, order.created_at)) {
      result.push(
        addError(
          `order.updated_at timestamp should be greater than order.created_at timestamp`,
          ERROR_CODES.INVALID_RESPONSE
        )
      );
    }
     const provider = order?.provider || {};
        if (Array.isArray(provider.creds) && provider.creds.length > 0) {
            const currentCred = provider.creds[0];
            const { id, descriptor } = currentCred;
      
            if (id && descriptor?.code && descriptor?.short_desc) {
              const stored = await RedisService.getKey(`${transaction_id}_${constants.ON_SEARCH}_credsDescriptor`);
              const storedCreds = stored ? JSON.parse(stored) : [];
      
              const isMatchFound = storedCreds.some((storedCred: any) =>
                storedCred.id === id &&
                storedCred.descriptor?.code === descriptor.code &&
                storedCred.descriptor?.short_desc === descriptor.short_desc
              );
      
              if (storedCreds.length > 0 && !isMatchFound ) {
                addError(
            
                    `Order validation failure: Credential (id + descriptor) in /${constants.ON_CONFIRM} does not match /${constants.ON_SEARCH}`,
                    23003,
                );
              }
            }
          }
    
  } catch (error: any) {
    console.error(
      `!!Error while validating order for /${constants.ON_STATUS_RTO_DELIVERED}, ${error.stack}`
    );
    result.push(
      addError(
        "Internal error while validating order",
        ERROR_CODES.INTERNAL_ERROR
      )
    );
  }
}

async function validateItems(
  order: any,
  transaction_id: string,
  result: ValidationError[]
): Promise<void> {
  try {
    const itemsOnSelectRaw = await RedisService.getKey(
      `${transaction_id}_SelectItemList`
    );
    const itemsOnSelect = itemsOnSelectRaw
      ? JSON.parse(itemsOnSelectRaw)
      : null;
    const itemFlfllmntsRaw = await RedisService.getKey(
      `${transaction_id}_itemFlfllmnts`
    );

    const itemFlfllmnts = itemFlfllmntsRaw
      ? JSON.parse(itemFlfllmntsRaw)
      : null;
    const selectItemsRaw = await RedisService.getKey(`${transaction_id}_items`);
    const selectItems = selectItemsRaw ? JSON.parse(selectItemsRaw) : null;

    const itemSet = new Set();
    const itemsList = order.items || [];
    const quoteObj = order.quote?.breakup || [];

    quoteObj.forEach((item: any) => {
      if (
        !itemsOnSelect?.includes(item["@ondc/org/item_id"]) &&
        item["@ondc/org/title_type"] === "item"
      ) {
        result.push(
          addError(
            `Invalid Item Id provided in quote object /${constants.ON_STATUS_RTO_DELIVERED}: ${item.id}`,
            ERROR_CODES.INVALID_RESPONSE
          )
        );
      }
    });

    let onCancelItemCount = 0;
    let onSelectItemCount = 0;
    const selectItemsMap: any = {};
    selectItems?.forEach((selectItem: any) => {
      onSelectItemCount += selectItem.quantity.count / 1;
      selectItemsMap[selectItem.count] = selectItem.quantity.count;
      selectItemsMap[selectItem.id] = selectItem.id;
    });

    itemsList.forEach((item: any, index: number) => {
      if (!itemsOnSelect?.includes(item.id)) {
        result.push(
          addError(
            `Invalid Item Id provided in /${constants.ON_STATUS_RTO_DELIVERED}: ${item.id}`,
            ERROR_CODES.INVALID_RESPONSE
          )
        );
      } else {
        itemSet.add(item.id);
      }
      onCancelItemCount += item.quantity.count / 1;
    });

    if (onSelectItemCount !== onCancelItemCount) {
      result.push(
        addError(
          `Total item count in message/order/items doesn't match with item count of /${constants.ON_SELECT}`,
          ERROR_CODES.INVALID_RESPONSE
        )
      );
    }

    let forwardFulfillmentCount = 0;
    let cancellationFulfillmentCount = 0;
    itemsList.forEach((item: any) => {
      const itemId = item.id;
      if (!(itemId in itemFlfllmnts)) {
        result.push(
          addError(
            `${itemId} itemID not found in ${constants.ON_SELECT}`,
            ERROR_CODES.INVALID_RESPONSE
          )
        );
      }
      if (
        itemFlfllmnts &&
        Object.values(itemFlfllmnts).includes(item.fulfillment_id)
      ) {
        forwardFulfillmentCount++;
      }
      if (
        itemFlfllmnts &&
        !Object.values(itemFlfllmnts).includes(item.fulfillment_id)
      ) {
        cancellationFulfillmentCount++;
      }
    });

    if (cancellationFulfillmentCount !== forwardFulfillmentCount) {
      result.push(
        addError(
          `The count of cancellation fulfillments is not equal to the count of forward fulfillments or invalid fulfillment id.`,
          ERROR_CODES.INVALID_RESPONSE
        )
      );
    }

    const fulfillmentIdsOnSelectRaw = await RedisService.getKey(
      `${transaction_id}_selectFlflmntSet`
    );
    const fulfillmentIdsOnSelect = fulfillmentIdsOnSelectRaw
      ? JSON.parse(fulfillmentIdsOnSelectRaw)
      : null;

    itemsList.forEach((item: any, index: number) => {
      if (fulfillmentIdsOnSelect) {
        if (
          fulfillmentIdsOnSelect.includes(item.fulfillment_id) &&
          item.quantity.count !== 0
        ) {
          result.push(
            addError(
              `Item count should be 0 for /${constants.ON_STATUS_RTO_DELIVERED} in forward shipment`,
              ERROR_CODES.INVALID_RESPONSE
            )
          );
        } else if (
          !fulfillmentIdsOnSelect.includes(item.fulfillment_id) &&
          item.quantity.count === 0
        ) {
          result.push(
            addError(
              `Item count can't be 0 for /${constants.ON_STATUS_RTO_DELIVERED} in cancel shipment`,
              ERROR_CODES.INVALID_RESPONSE
            )
          );
        }
      }
    });
  } catch (error: any) {
    console.error(
      `!!Error while validating items for /${constants.ON_STATUS_RTO_DELIVERED}, ${error.stack}`
    );
    result.push(
      addError(
        "Internal error while validating items",
        ERROR_CODES.INTERNAL_ERROR
      )
    );
  }
}

async function validateFulfillments(
  order: any,
  transaction_id: string,
  flow: string,
  result: ValidationError[]
): Promise<void> {
  try {
    const fulfillments = order.fulfillments || [];
    const rtoObj = _.filter(fulfillments, { type: "RTO" });
    const deliveryObj = _.filter(fulfillments, { type: "Delivery" });
    let rto_start_location: any = {};
    let rto_end_location: any = {};
    let del_start_location: any = {};
    let del_end_location: any = {};
    let rto_delivered_or_disposed: boolean = false;

    // Validate RTO Fulfillment
    if (!rtoObj.length) {
      console.error(
        `RTO object is mandatory for ${constants.ON_STATUS_RTO_DELIVERED}`
      );
      result.push(
        addError(
          `RTO object is mandatory for ${constants.ON_STATUS_RTO_DELIVERED}`,
          ERROR_CODES.ORDER_VALIDATION_FAILURE
        )
      );
    } else {
      for (let item of rtoObj) {
        const validVal = ["RTO-Delivered", "RTO-Disposed"];
        if (!validVal.includes(item.state?.descriptor?.code)) {
          console.error(
            `Delivery state should be one of ['RTO-Delivered', 'RTO-Disposed'] for ${constants.ON_STATUS_RTO_DELIVERED}`
          );
          result.push(
            addError(
              `Delivery state should be one of ['RTO-Delivered', 'RTO-Disposed'] for ${constants.ON_STATUS_RTO_DELIVERED}`,
              ERROR_CODES.INVALID_ORDER_STATE
            )
          );
        } else if (
          item.state.descriptor.code === validVal[0] ||
          item.state.descriptor.code === validVal[1]
        ) {
          rto_delivered_or_disposed = true;
        }
      }

      if (!_.isEmpty(rtoObj[0]?.start)) {
        const rto_obj_start = rtoObj[0]?.start;
        if (!_.isEmpty(rto_obj_start.location)) {
          rto_start_location = rto_obj_start.location;
        } else {
          result.push(
            addError(
              `RTO fulfillment start location object is missing in ${constants.ON_STATUS_RTO_DELIVERED}`,
              ERROR_CODES.INVALID_RESPONSE
            )
          );
        }
      } else {
        result.push(
          addError(
            `RTO fulfillment start object is missing in ${constants.ON_STATUS_RTO_DELIVERED}`,
            ERROR_CODES.INVALID_RESPONSE
          )
        );
      }

      if (!_.isEmpty(rtoObj[0]?.end)) {
        const rto_obj_end = rtoObj[0]?.end;
        if (rto_delivered_or_disposed) {
          if (_.isEmpty(rto_obj_end.time)) {
            result.push(
              addError(
                `fulfillment type rto end/time is missing in /${constants.ON_STATUS_RTO_DELIVERED}`,
                ERROR_CODES.INVALID_FULFILLMENT_TAT
              )
            );
          } else if (_.isEmpty(rto_obj_end.time.timestamp)) {
            result.push(
              addError(
                `fulfillment type rto end/time/timestamp is missing in /${constants.ON_STATUS_RTO_DELIVERED}`,
                ERROR_CODES.INVALID_FULFILLMENT_TAT
              )
            );
          } else {
            const date = new Date(rto_obj_end.time.timestamp);
            if (String(date) === "Invalid Date") {
              result.push(
                addError(
                  `fulfillment type rto end/time/timestamp is not of a valid date format in /${constants.ON_STATUS_RTO_DELIVERED}`,
                  ERROR_CODES.INVALID_FULFILLMENT_TAT
                )
              );
            }
          }
        }
        if (!_.isEmpty(rto_obj_end?.location)) {
          rto_end_location = rto_obj_end.location;
        } else {
          result.push(
            addError(
              `RTO fulfillment end location object is missing in ${constants.ON_STATUS_RTO_DELIVERED}`,
              ERROR_CODES.INVALID_RESPONSE
            )
          );
        }
      } else {
        result.push(
          addError(
            `RTO fulfillment end object is missing in ${constants.ON_STATUS_RTO_DELIVERED}`,
            ERROR_CODES.INVALID_RESPONSE
          )
        );
      }

      const rtoObjRaw = await RedisService.getKey(`${transaction_id}_RTO_Obj`);
      const onCancelRtoObj = rtoObjRaw ? JSON.parse(rtoObjRaw) : null;
      if (onCancelRtoObj) {
        let rtoCopy = { ...rtoObj[0] };
        rtoCopy = structuredClone(rtoCopy)
        delete rtoCopy.end?.time;
        delete rtoCopy.state;
        delete onCancelRtoObj?.state;
        const keys = Object.keys(rtoCopy);
        const errors = compareFulfillmentObject(
          rtoCopy,
          onCancelRtoObj,
          keys,
          0,
          constants.ON_STATUS_RTO_DELIVERED
        );
        errors.forEach((item: any) => {
          result.push(addError(item.errMsg, ERROR_CODES.INVALID_RESPONSE));
        });
      }
    }

    // Validate Delivery Fulfillment
    if (!deliveryObj.length) {
      console.error(
        `Delivery object is mandatory for ${constants.ON_STATUS_RTO_DELIVERED}`
      );
      result.push(
        addError(
          `Delivery object is mandatory for ${constants.ON_STATUS_RTO_DELIVERED}`,
          ERROR_CODES.ORDER_VALIDATION_FAILURE
        )
      );
    } else {
      if (!_.isEmpty(deliveryObj[0]?.start)) {
        const del_obj_start = deliveryObj[0]?.start;
        if (!_.isEmpty(del_obj_start?.location)) {
          del_start_location = del_obj_start.location;
        } else {
          console.error(
            `Delivery fulfillment start location is missing in ${constants.ON_STATUS_RTO_DELIVERED}`
          );
          result.push(
            addError(
              `Delivery fulfillment start location object is missing in ${constants.ON_STATUS_RTO_DELIVERED}`,
              ERROR_CODES.INVALID_RESPONSE
            )
          );
        }
      } else {
        result.push(
          addError(
            `Delivery fulfillment start object is missing in ${constants.ON_STATUS_RTO_DELIVERED}`,
            ERROR_CODES.INVALID_RESPONSE
          )
        );
      }

      if (!_.isEmpty(deliveryObj[0]?.end)) {
        const del_obj_end = deliveryObj[0]?.end;
        if (!_.isEmpty(del_obj_end?.location)) {
          del_end_location = del_obj_end.location;
        } else {
          result.push(
            addError(
              `Delivery fulfillment end location object is missing in ${constants.ON_STATUS_RTO_DELIVERED}`,
              ERROR_CODES.INVALID_RESPONSE
            )
          );
        }
      } else {
        result.push(
          addError(
            `Delivery fulfillment end object is missing in ${constants.ON_STATUS_RTO_DELIVERED}`,
            ERROR_CODES.INVALID_RESPONSE
          )
        );
      }

      const delObjRaw = await RedisService.getKey(`${transaction_id}_DEL_Obj`);
      const onCancelDELObj = delObjRaw ? JSON.parse(delObjRaw) : null;
      if (onCancelDELObj && deliveryObj.length) {
        const keys = Object.keys(deliveryObj[0]);
        const errors = compareFulfillmentObject(
          deliveryObj[0],
          onCancelDELObj,
          keys,
          1,
          constants.ON_STATUS_RTO_DELIVERED
        );
        errors.forEach((item: any) => {
          result.push(addError(item.errMsg, ERROR_CODES.INVALID_RESPONSE));
        });
      }

      // Delivery Tags and Cancellation Checks
      let reasonID_flag = 0;
      let rto_id_flag = 0;
      let initiated_by_flag = 0;
      for (let item of deliveryObj) {
        if (item.state?.descriptor?.code !== "Cancelled") {
          console.error(
            `Delivery state should be Cancelled for ${constants.ON_STATUS_RTO_DELIVERED}`
          );
          result.push(
            addError(
              `Delivery state should be Cancelled for ${constants.ON_STATUS_RTO_DELIVERED}`,
              ERROR_CODES.INVALID_ORDER_STATE
            )
          );
        }
        if (
          item.state?.descriptor?.code === "Cancelled" &&
          (!item.tags || !item.tags.length)
        ) {
          console.error(
            `Tags are mandatory for ${constants.ON_STATUS_RTO_DELIVERED} on cancelled state`
          );
          result.push(
            addError(
              `Tags are mandatory for ${constants.ON_STATUS_RTO_DELIVERED} on cancelled state for fulfillment type delivery`,
              ERROR_CODES.INVALID_RESPONSE
            )
          );
        }
        const cancel_request = _.filter(item.tags, { code: "cancel_request" });
        if (!cancel_request.length) {
          console.error(
            `Cancel Request is mandatory for ${constants.ON_STATUS_RTO_DELIVERED}`
          );
          result.push(
            addError(
              `Cancel Request is mandatory for ${constants.ON_STATUS_RTO_DELIVERED} in fulfillment type delivery`,
              ERROR_CODES.INVALID_RESPONSE
            )
          );
        } else {
          cancel_request.forEach((tag: any) => {
            if (!tag.list) {
              result.push(
                addError(
                  `List object is mandatory for cancel_request`,
                  ERROR_CODES.INVALID_RESPONSE
                )
              );
              return;
            }
            tag.list.some((i: any) => {
              if (i.code === "reason_id") reasonID_flag = 1;
              if (i.code === "rto_id") rto_id_flag = 1;
              if (i.code === "initiated_by") initiated_by_flag = 1;
            });
          });
        }
        const preCancelObj = _.filter(item.tags, { code: "precancel_state" });
        if (!preCancelObj.length) {
          console.error(
            `Pre Cancel is mandatory for ${constants.ON_STATUS_RTO_DELIVERED}`
          );
          result.push(
            addError(
              `Pre Cancel is mandatory for ${constants.ON_STATUS_RTO_DELIVERED}`,
              ERROR_CODES.INVALID_RESPONSE
            )
          );
        } else {
          const timeStampObj = _.filter(preCancelObj[0]?.list, {
            code: "updated_at",
          });
          if (!timeStampObj.length) {
            console.error(
              `Pre Cancel timestamp is mandatory for ${constants.ON_STATUS_RTO_DELIVERED}`
            );
            result.push(
              addError(
                `Pre Cancel Updated at timeStamp is mandatory for ${constants.ON_STATUS_RTO_DELIVERED}`,
                ERROR_CODES.INVALID_RESPONSE
              )
            );
          } else {
            const previousTimestampRaw = await RedisService.getKey(
              `${transaction_id}_PreviousUpdatedTimestamp`
            );
            const previousTimestamp = previousTimestampRaw
              ? JSON.parse(previousTimestampRaw)
              : null;
            if (!_.isEqual(previousTimestamp, timeStampObj[0].value)) {
              console.error(
                `precancel_state.updated_at of ${
                  constants.ON_STATUS_RTO_DELIVERED
                } is not equal with the ${
                  flow === "4"
                    ? constants.ON_CONFIRM
                    : constants.ON_STATUS_OUT_FOR_DELIVERY
                } order.updated_at`
              );
              result.push(
                addError(
                  `precancel_state.updated_at of ${
                    constants.ON_STATUS_RTO_DELIVERED
                  } is not equal with the ${
                    flow === "4"
                      ? constants.ON_CONFIRM
                      : constants.ON_STATUS_OUT_FOR_DELIVERY
                  } order.updated_at`,
                  ERROR_CODES.INVALID_RESPONSE
                )
              );
            }
          }
        }
      }
      if (!reasonID_flag) {
        console.error(
          `Reason ID is mandatory field for ${constants.ON_STATUS_RTO_DELIVERED}`
        );
        result.push(
          addError(
            `Reason ID is mandatory field for ${constants.ON_STATUS_RTO_DELIVERED}`,
            ERROR_CODES.INVALID_RESPONSE
          )
        );
      }
      if (!rto_id_flag && flow === "5") {
        console.error(
          `RTO Id is mandatory field for ${constants.ON_STATUS_RTO_DELIVERED}`
        );
        result.push(
          addError(
            `RTO Id is mandatory field for ${constants.ON_STATUS_RTO_DELIVERED}`,
            ERROR_CODES.INVALID_RESPONSE
          )
        );
      }
      if (!initiated_by_flag) {
        console.error(
          `Initiated_by is mandatory field for ${constants.ON_STATUS_RTO_DELIVERED}`
        );
        result.push(
          addError(
            `Initiated_by is mandatory field for ${constants.ON_STATUS_RTO_DELIVERED}`,
            ERROR_CODES.INVALID_RESPONSE
          )
        );
      }
    }

    // Location Comparisons
    if (!_.isEmpty(rto_start_location) && !_.isEmpty(del_end_location)) {
      if (!_.isEqual(rto_start_location?.address, del_end_location?.address)) {
        result.push(
          addError(
            `RTO fulfillment start and Delivery fulfillment end location mismatch in ${constants.ON_STATUS_RTO_DELIVERED}`,
            ERROR_CODES.INVALID_RESPONSE
          )
        );
      }
    } else {
      result.push(
        addError(
          `RTO fulfillment start or Delivery fulfillment end location is missing in ${constants.ON_STATUS_RTO_DELIVERED}`,
          ERROR_CODES.INVALID_RESPONSE
        )
      );
    }

    if (
      !_.isEmpty(rto_start_location?.address) &&
      !_.isEmpty(del_start_location?.address) &&
      _.isEqual(rto_start_location?.address, del_start_location?.address)
    ) {
      result.push(
        addError(
          `RTO fulfillment start and Delivery fulfillment start location should not be equal in ${constants.ON_STATUS_RTO_DELIVERED}`,
          ERROR_CODES.INVALID_RESPONSE
        )
      );
    }

    if (!_.isEmpty(rto_end_location) && !_.isEmpty(del_start_location)) {
      if (!_.isEqual(rto_end_location?.address, del_start_location?.address)) {
        result.push(
          addError(
            `RTO fulfillment end and Delivery fulfillment start location mismatch in ${constants.ON_STATUS_RTO_DELIVERED}`,
            ERROR_CODES.INVALID_RESPONSE
          )
        );
      }
      if (_.isEmpty(rto_end_location?.id)) {
        result.push(
          addError(
            `RTO fulfillment end location id missing in ${constants.ON_STATUS_RTO_DELIVERED}`,
            ERROR_CODES.INVALID_RESPONSE
          )
        );
      }
      if (_.isEmpty(del_start_location?.id)) {
        result.push(
          addError(
            `Delivery fulfillment start location id missing in ${constants.ON_STATUS_RTO_DELIVERED}`,
            ERROR_CODES.INVALID_RESPONSE
          )
        );
      }
      if (!_.isEqual(rto_end_location?.id, del_start_location?.id)) {
        result.push(
          addError(
            `RTO fulfillment end and Delivery fulfillment start location id mismatch in ${constants.ON_STATUS_RTO_DELIVERED}`,
            ERROR_CODES.INVALID_RESPONSE
          )
        );
      }
    } else {
      result.push(
        addError(
          `RTO fulfillment end or Delivery fulfillment start location is missing in ${constants.ON_STATUS_RTO_DELIVERED}`,
          ERROR_CODES.INVALID_RESPONSE
        )
      );
    }

    if (
      !_.isEmpty(rto_end_location?.address) &&
      !_.isEmpty(del_end_location?.address) &&
      _.isEqual(rto_end_location?.address, del_end_location?.address)
    ) {
      result.push(
        addError(
          `RTO fulfillment end and Delivery fulfillment end location should not be equal in ${constants.ON_STATUS_RTO_DELIVERED}`,
          ERROR_CODES.INVALID_RESPONSE
        )
      );
    }
  } catch (error: any) {
    console.error(
      `!!Error while checking Reason ID, RTO Id and Initiated_by for ${constants.ON_STATUS_RTO_DELIVERED}, ${error.stack}`
    );
    result.push(
      addError(
        `Internal error while validating fulfillments for ${constants.ON_STATUS_RTO_DELIVERED}`,
        ERROR_CODES.INTERNAL_ERROR
      )
    );
  }
}

async function validateQuote(
  order: any,
  transaction_id: string,
  flow: string,
  result: ValidationError[]
): Promise<void> {
  try {
    if (!sumQuoteBreakUp(order.quote)) {
      result.push(
        addError(
          `item quote breakup prices for ${constants.ON_STATUS_RTO_DELIVERED} should be equal to the total price.`,
          ERROR_CODES.INVALID_RESPONSE
        )
      );
    } else {
      const price = Number(order.quote.price.value);
      const priceAtConfirmRaw = await RedisService.getKey(
        `${transaction_id}_quotePrice`
      );
      const priceAtConfirm = priceAtConfirmRaw
        ? JSON.parse(priceAtConfirmRaw)
        : null;
      let cancelFulfillments = null;
      if (flow === "5") {
        cancelFulfillments = _.filter(order.fulfillments, { type: "RTO" });
      } else {
        cancelFulfillments = _.filter(order.fulfillments, { type: "Cancel" });
      }

      if (!cancelFulfillments.length && flow === "4") {
        result.push(
          addError(
            `fulfillment type cancel is missing in /${constants.ON_STATUS_RTO_DELIVERED}`,
            ERROR_CODES.ORDER_VALIDATION_FAILURE
          )
        );
      }

      checkQuoteTrailSum(
        cancelFulfillments,
        price,
        priceAtConfirm,
        result,
        ApiSequence.ON_CANCEL
      );

      const selectPriceMapRaw = await RedisService.getKey(
        `${transaction_id}_selectPriceMap`
      );
      const selectPriceMap = selectPriceMapRaw
        ? new Map(JSON.parse(selectPriceMapRaw))
        : new Map();
      const itemSet = new Set(order.items?.map((item: any) => item.id) || []);
      for (let obj of cancelFulfillments) {
        const quoteTrailItems = _.filter(obj.tags, { code: "quote_trail" });
        checkQuoteTrail(quoteTrailItems, result, selectPriceMap, itemSet);
      }
    }
  } catch (error: any) {
    console.error(
      `!!Error while validating quote for /${constants.ON_STATUS_RTO_DELIVERED}, ${error.stack}`
    );
    result.push(
      addError(
        "Internal error while validating quote",
        ERROR_CODES.INTERNAL_ERROR
      )
    );
  }
}

async function validateCancellation(
  order: any,
  context: any,
  transaction_id: string,
  flow: string,
  result: ValidationError[]
): Promise<void> {
  try {
    const cancellationObj = order?.cancellation;
    if (_.isEmpty(cancellationObj)) {
      result.push(
        addError(
          "Order.cancellation must be present!",
          ERROR_CODES.CANCELLATION_INVALID_REASON
        )
      );
    } else {
      const cancelled_by = cancellationObj.cancelled_by;
      const reason_id = cancellationObj.reason.id;

      if (cancelled_by === context.bap_id) {
        mapCancellationID("BNP", reason_id, result);
      } else {
        mapCancellationID("SNP", reason_id, result);
      }
    }
  } catch (error: any) {
    console.error(
      `!!Error while validating cancellation for /${constants.ON_STATUS_RTO_DELIVERED}, ${error.stack}`
    );
    result.push(
      addError(
        "Internal error while validating cancellation",
        ERROR_CODES.INTERNAL_ERROR
      )
    );
  }
}

async function validateBilling(
  order: any,
  transaction_id: string,
  result: ValidationError[]
): Promise<void> {
  try {
    const billingRaw = await RedisService.getKey(`${transaction_id}_billing`);
    const billing = billingRaw ? JSON.parse(billingRaw) : null;
    const billingErrors = compareObjects(billing, order.billing);
    if (billingErrors) {
      billingErrors.forEach((error: string, i: number) =>
        result.push(
          addError(
            `${error} when compared with init billing object`,
            ERROR_CODES.INVALID_RESPONSE
          )
        )
      );
    }

    await RedisService.setKey(
      `${transaction_id}_billing`,
      JSON.stringify(order.billing),
      TTL_IN_SECONDS
    );
  } catch (error: any) {
    console.error(
      `!!Error while validating billing for /${constants.ON_STATUS_RTO_DELIVERED}, ${error.stack}`
    );
    result.push(
      addError(
        "Internal error while validating billing",
        ERROR_CODES.INTERNAL_ERROR
      )
    );
  }
}

async function validatePayment(
  order: any,
  transaction_id: string,
  flow: string,
  result: ValidationError[]
): Promise<void> {
  try {
    const sttlmntdtlsRaw = await RedisService.getKey(
      `${transaction_id}_sttlmntdtls`
    );
    const sttlmntdtls = sttlmntdtlsRaw ? JSON.parse(sttlmntdtlsRaw) : null;
    if (
      !_.isEqual(order.payment["@ondc/org/settlement_details"][0], sttlmntdtls)
    ) {
      result.push(
        addError(
          `payment settlement_details mismatch in /${constants.ON_INIT} & /${constants.ON_STATUS_RTO_DELIVERED}`,
          ERROR_CODES.INVALID_RESPONSE
        )
      );
    }

    const status = payment_status(order.payment, flow);
    if (!status) {
      result.push(
        addError(
          `Transaction_id missing in message/order/payment`,
          ERROR_CODES.INVALID_RESPONSE
        )
      );
    }

    await RedisService.setKey(
      `${transaction_id}_prevPayment`,
      JSON.stringify(order.payment),
      TTL_IN_SECONDS
    );
  } catch (error: any) {
    console.error(
      `!!Error while validating payment for /${constants.ON_STATUS_RTO_DELIVERED}, ${error.stack}`
    );
    result.push(
      addError(
        "Internal error while validating payment",
        ERROR_CODES.INTERNAL_ERROR
      )
    );
  }
}

const checkOnStatusRTODelivered = async (
  data: any
): Promise<ValidationError[]> => {
  const result: ValidationError[] = [];

  try {
    if (!data || isObjectEmpty(data)) {
      result.push(
        addError("JSON cannot be empty", ERROR_CODES.INVALID_RESPONSE)
      );
      return result;
    }

    const { context, message } = data;
    if (
      !message ||
      !context ||
      !message.order ||
      isObjectEmpty(message) ||
      isObjectEmpty(message.order)
    ) {
      result.push(
        addError(
          "/context, /message, /order or /message/order is missing or empty",
          ERROR_CODES.INVALID_RESPONSE
        )
      );
      return result;
    }

    const flow = "5";
    const { transaction_id } = context;
    const order = message.order;

    await Promise.all([
      validateContext(context, transaction_id, result),
      validateTimestamps(context, transaction_id, result),
      validateOrder(order, transaction_id, result),
      validateItems(order, transaction_id, result),
      validateFulfillments(order, transaction_id, flow, result),
      validateQuote(order, transaction_id, flow, result),
      validateCancellation(order, context, transaction_id, flow, result),
      validateBilling(order, transaction_id, result),
      validatePayment(order, transaction_id, flow, result),
      RedisService.setKey(
        `${transaction_id}_${ApiSequence.ON_STATUS_RTO_DELIVERED}`,
        JSON.stringify(data),
        TTL_IN_SECONDS
      ),
    ]);

    return result;
  } catch (err: any) {
    console.error(
      `!!Some error occurred while checking /${constants.ON_STATUS_RTO_DELIVERED} API, ${err.stack}`
    );
    result.push(
      addError(
        "Internal error processing /on_status_rto_delivered request",
        ERROR_CODES.INTERNAL_ERROR
      )
    );
    return result;
  }
};

export default checkOnStatusRTODelivered;
