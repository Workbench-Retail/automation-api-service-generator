import _ from "lodash";
import { RedisService } from "ondc-automation-cache-lib";

import constants, {
  ApiSequence,
  PAYMENT_STATUS,
} from "../../utils/constants";
import {
  areTimestampsLessThanOrEqualTo,
  compareTimeRanges,
  compareFulfillmentObject,
  compareObjects,
  compareQuoteObjects,
  sumQuoteBreakUp,
  compareCoordinates,
  payment_status,
} from "../../utils/helper";
import { FLOW } from "../../utils/enums";
import { contextChecker } from "../../utils/contextUtils";
import { validateOfferQuoteBreakup } from "./on_status_pending";

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
};

const TTL_IN_SECONDS: number = Number(process.env.TTL_IN_SECONDS) || 3600;

// Utility function to create error objects
const addError = (description: string, code: number): ValidationError => ({
  valid: false,
  code,
  description,
});

async function validateOrder(
  order: any,
  transaction_id: string,
  state: string,
  result: ValidationError[]
): Promise<void> {
  const cnfrmOrdrId = await RedisService.getKey(
    `${transaction_id}_cnfrmOrdrId`
  );
  if (cnfrmOrdrId && order.id !== cnfrmOrdrId) {
    result.push(
      addError(
        `Order id in /${constants.CONFIRM} and /${constants.ON_STATUS}_${state} do not match`,
        ERROR_CODES.INVALID_RESPONSE
      )
    );
  }

  if (order.state !== "In-progress") {
    result.push(
      addError(
        `order/state should be "In-progress" for /${constants.ON_STATUS}_${state}`,
        ERROR_CODES.INVALID_ORDER_STATE
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
        `Provider Id mismatches in /${constants.ON_SEARCH} and /${constants.ON_STATUS}_${state}`,
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
        `provider.locations[0].id mismatches in /${constants.ON_SEARCH} and /${constants.ON_STATUS}_${state}`,
        ERROR_CODES.INVALID_RESPONSE
      )
    );
  }
  const provider = order?.provider || {};
  if (Array.isArray(provider.creds) && provider.creds.length > 0) {
    const currentCred = provider.creds[0];
    const { id, descriptor } = currentCred;

    if (id && descriptor?.code && descriptor?.short_desc) {
      const stored = await RedisService.getKey(
        `${transaction_id}_${constants.ON_SEARCH}_credsDescriptor`
      );
      const storedCreds = stored ? JSON.parse(stored) : [];

      const isMatchFound = storedCreds.some(
        (storedCred: any) =>
          storedCred.id === id &&
          storedCred.descriptor?.code === descriptor.code &&
          storedCred.descriptor?.short_desc === descriptor.short_desc
      );

      if (storedCreds.length > 0 && !isMatchFound) {
        addError(
          `Order validation failure: Credential (id + descriptor) in /${constants.ON_CONFIRM} does not match /${constants.ON_SEARCH}`,
          23003
        );
      }
    }
  }

  await RedisService.setKey(
    `${transaction_id}_orderState`,
    JSON.stringify(order.state),
    TTL_IN_SECONDS
  );
}

async function validateFulfillments(
  order: any,
  transaction_id: string,
  state: string,
  fulfillmentsItemsSet: Set<any>,
  result: ValidationError[]
): Promise<void> {
  const [itemFlfllmntsRaw, buyerGpsRaw, buyerAddrRaw, providerAddrRaw] =
    await Promise.all([
      RedisService.getKey(`${transaction_id}_itemFlfllmnts`),
      RedisService.getKey(`${transaction_id}_buyerGps`),
      RedisService.getKey(`${transaction_id}_buyerAddr`),
      RedisService.getKey(`${transaction_id}_providerAddr`),
    ]);
  const itemFlfllmnts = itemFlfllmntsRaw ? JSON.parse(itemFlfllmntsRaw) : null;
  const buyerGps = buyerGpsRaw ? JSON.parse(buyerGpsRaw) : null;
  const buyerAddr = buyerAddrRaw ? JSON.parse(buyerAddrRaw) : null;
  const providerAddr = providerAddrRaw ? JSON.parse(providerAddrRaw) : null;

  for (const ff of order.fulfillments || []) {
    if (!ff.id) {
      result.push(
        addError(`Fulfillment Id must be present`, ERROR_CODES.INVALID_RESPONSE)
      );
    }

    if (!ff.type) {
      result.push(
        addError(
          `Fulfillment type does not exist in /${constants.ON_STATUS}_${state}`,
          ERROR_CODES.INVALID_RESPONSE
        )
      );
    }

    if (ff.type !== "Cancel") {
      const ffTrackingRaw = await RedisService.getKey(
        `${transaction_id}_${ff.id}_tracking`
      );
      const ffTracking = ffTrackingRaw ? JSON.parse(ffTrackingRaw) : null;
      if (ffTracking !== null) {
        if (typeof ff.tracking !== "boolean") {
          result.push(
            addError(
              `Tracking must be present for fulfillment ID: ${ff.id} in boolean form`,
              ERROR_CODES.INVALID_RESPONSE
            )
          );
        } else if (ffTracking !== ff.tracking) {
          result.push(
            addError(
              `Fulfillment Tracking mismatch with the ${constants.ON_SELECT} call`,
              ERROR_CODES.INVALID_RESPONSE
            )
          );
        }
      }
    }

    if (ff?.type == "Delivery") {
      if (!itemFlfllmnts || !Object.values(itemFlfllmnts).includes(ff.id)) {
        result.push(
          addError(
            `Fulfillment id ${ff.id || "missing"} does not exist in /${
              constants.ON_SELECT
            }`,
            ERROR_CODES.INVALID_RESPONSE
          )
        );
      }

      {
        const ffDesc = ff.state?.descriptor;
        const ffStateCheck =
          ffDesc?.hasOwnProperty("code") && ffDesc.code === "Agent-assigned";
        if (!ffStateCheck) {
          result.push(
            addError(
              `Fulfillment state should be 'Agent-assigned' in /${constants.ON_STATUS}_${state}`,
              ERROR_CODES.INVALID_ORDER_STATE
            )
          );
        }
      }
      if (!ff.start || !ff.end) {
        result.push(
          addError(
            `fulfillments[${ff.id}] start and end locations are mandatory`,
            ERROR_CODES.INVALID_RESPONSE
          )
        );
      }

      if (
        ff.start?.location?.gps &&
        !compareCoordinates(ff.start.location.gps, providerAddr?.location?.gps)
      ) {
        result.push(
          addError(
            `store gps location /fulfillments[${ff.id}]/start/location/gps can't change`,
            ERROR_CODES.INVALID_RESPONSE
          )
        );
      }

      if (
        (!providerAddr ||
          !_.isEqual(
            ff?.start?.location?.descriptor?.name,
            providerAddr?.location?.descriptor?.name
          )) &&
        ff?.type == "Delivery"
      ) {
        result.push(
          addError(
            `store name /fulfillments[${ff.id}]/start/location/descriptor/name can't change`,
            ERROR_CODES.INVALID_RESPONSE
          )
        );
      }

      if (ff.end?.location?.gps && !_.isEqual(ff.end.location.gps, buyerGps)) {
        result.push(
          addError(
            `fulfillments[${ff.id}].end.location gps is not matching with gps in /${constants.SELECT}`,
            ERROR_CODES.INVALID_RESPONSE
          )
        );
      }

      if (
        ff.end?.location?.address?.area_code &&
        !_.isEqual(ff.end.location.address.area_code, buyerAddr)
      ) {
        result.push(
          addError(
            `fulfillments[${ff.id}].end.location.address.area_code is not matching with area_code in /${constants.SELECT}`,
            ERROR_CODES.INVALID_RESPONSE
          )
        );
      }
    }
  }
  const storedFulfillmentRaw = await RedisService.getKey(
    `${transaction_id}_deliveryFulfillment`
  );
  const storedFulfillment = storedFulfillmentRaw
    ? JSON.parse(storedFulfillmentRaw)
    : null;
  const deliveryFulfillment = order.fulfillments.filter(
    (f: any) => f.type === "Delivery"
  );

  if (!storedFulfillment) {
    if (deliveryFulfillment.length > 0) {
      await Promise.all([
        RedisService.setKey(
          `${transaction_id}_deliveryFulfillment`,
          JSON.stringify(deliveryFulfillment[0]),
          TTL_IN_SECONDS
        ),
        RedisService.setKey(
          `${transaction_id}_deliveryFulfillmentAction`,
          JSON.stringify(ApiSequence.ON_STATUS_AGENT_ASSIGNED),
          TTL_IN_SECONDS
        ),
      ]);
    }
  } else {
    const storedFulfillmentActionRaw = await RedisService.getKey(
      `${transaction_id}_deliveryFulfillmentAction`
    );
    const storedFulfillmentAction = storedFulfillmentActionRaw
      ? JSON.parse(storedFulfillmentActionRaw)
      : null;
    const fulfillmentRangeErrors = compareTimeRanges(
      storedFulfillment,
      storedFulfillmentAction,
      deliveryFulfillment[0],
      ApiSequence.ON_STATUS_AGENT_ASSIGNED
    );

    if (fulfillmentRangeErrors) {
      fulfillmentRangeErrors.forEach((error: string) => {
        result.push(addError(`${error}`, ERROR_CODES.INVALID_RESPONSE));
      });
    }
  }

  const flow = (await RedisService.getKey("flow")) || "2";
  if (["6", "2", "3", "5"].includes(flow)) {
    if (!order.fulfillments?.length) {
      result.push(
        addError(
          `missingFulfillments is mandatory for ${ApiSequence.ON_STATUS_AGENT_ASSIGNED}`,
          ERROR_CODES.ORDER_VALIDATION_FAILURE
        )
      );
    } else {
      let i = 0;
      for (let obj1 of fulfillmentsItemsSet) {
        const keys = Object.keys(obj1);
        let obj2 = order.fulfillments.filter((f: any) => f.type === obj1.type);
        let apiSeq =
          obj1.type === "Cancel"
            ? ApiSequence.ON_UPDATE_PART_CANCEL
            : (await RedisService.getKey(`${transaction_id}_onCnfrmState`)) ===
              "Accepted"
            ? ApiSequence.ON_CONFIRM
            : ApiSequence.ON_STATUS_PENDING;

        if (obj2.length > 0) {
          obj2 = obj2[0];
          obj2 = structuredClone(obj2)
          obj1 = structuredClone(obj1)
          if (obj2.type === "Delivery") {
            delete obj2?.start?.instructions;
            delete obj2?.end?.instructions;
            delete obj2?.tags;
            delete obj2?.state;
            delete obj1?.state;
          }
          const errors = compareFulfillmentObject(obj1, obj2, keys, i, apiSeq);
          errors.forEach((item: any) => {
            result.push(addError(item.errMsg, ERROR_CODES.INVALID_RESPONSE));
          });
        } else {
          result.push(
            addError(
              `Missing fulfillment type '${obj1.type}' in ${ApiSequence.ON_STATUS_AGENT_ASSIGNED} as compared to ${apiSeq}`,
              ERROR_CODES.INVALID_RESPONSE
            )
          );
        }
        i++;
      }

      const deliveryObjArr = order.fulfillments.filter(
        (f: any) => f.type === "Delivery"
      );
      if (!deliveryObjArr.length) {
        result.push(
          addError(
            `Delivery fulfillment must be present in ${ApiSequence.ON_STATUS_AGENT_ASSIGNED}`,
            ERROR_CODES.ORDER_VALIDATION_FAILURE
          )
        );
      } else {
        let deliverObj = { ...deliveryObjArr[0] };
        deliverObj = structuredClone(deliverObj)
        delete deliverObj?.state;
        delete deliverObj?.tags;
        delete deliverObj?.start?.instructions;
        delete deliverObj?.end?.instructions;
      }
    }
  }
}

async function validateTimestamps(
  order: any,
  context: any,
  transaction_id: string,
  state: string,
  result: ValidationError[]
): Promise<void> {
  const cnfrmTmpstmpRaw = await RedisService.getKey(
    `${transaction_id}_cnfrmTmpstmp`
  );
  const cnfrmTmpstmp = cnfrmTmpstmpRaw ? JSON.parse(cnfrmTmpstmpRaw) : null;
  if (cnfrmTmpstmp && !_.isEqual(cnfrmTmpstmp, order.created_at)) {
    result.push(
      addError(
        `Created At timestamp for /${constants.ON_STATUS}_${state} should be equal to context timestamp at ${constants.CONFIRM}`,
        ERROR_CODES.INVALID_RESPONSE
      )
    );
  }

  const onCnfrmTmpstmpRaw = await RedisService.getKey(
    `${transaction_id}_${ApiSequence.ON_CONFIRM}_tmpstmp`
  );
  const onCnfrmTmpstmp = onCnfrmTmpstmpRaw
    ? JSON.parse(onCnfrmTmpstmpRaw)
    : null;
  if (onCnfrmTmpstmp && _.gte(onCnfrmTmpstmp, context.timestamp)) {
    result.push(
      addError(
        `Timestamp for /${constants.ON_CONFIRM} api cannot be greater than or equal to /${constants.ON_STATUS}_${state} api`,
        ERROR_CODES.OUT_OF_SEQUENCE
      )
    );
  }

  const pendingTmpstmpRaw = await RedisService.getKey(
    `${transaction_id}_${ApiSequence.ON_STATUS_PENDING}_tmpstmp`
  );
  const pendingTmpstmp = pendingTmpstmpRaw
    ? JSON.parse(pendingTmpstmpRaw)
    : null;
  if (pendingTmpstmp && _.gte(pendingTmpstmp, context.timestamp)) {
    result.push(
      addError(
        `Timestamp for /${constants.ON_STATUS}_Pending api cannot be greater than or equal to /${constants.ON_STATUS}_${state} api`,
        ERROR_CODES.OUT_OF_SEQUENCE
      )
    );
  }

  if (!areTimestampsLessThanOrEqualTo(order.updated_at, context.timestamp)) {
    result.push(
      addError(
        `order.updated_at timestamp should be less than or equal to context timestamp for /${constants.ON_STATUS}_${state} api`,
        ERROR_CODES.INVALID_RESPONSE
      )
    );
  }

  await RedisService.setKey(
    `${transaction_id}_${ApiSequence.ON_STATUS_AGENT_ASSIGNED}_tmpstmp`,
    JSON.stringify(context.timestamp),
    TTL_IN_SECONDS
  );
}

async function validatePayment(
  order: any,
  transaction_id: string,
  flow: string,
  state: string,
  result: ValidationError[]
): Promise<void> {
  const prevPaymentRaw = await RedisService.getKey(
    `${transaction_id}_prevPayment`
  );
  const prevPayment = prevPaymentRaw ? JSON.parse(prevPaymentRaw) : null;
  if (prevPayment && !_.isEqual(prevPayment, order.payment)) {
    result.push(
      addError(
        `payment object mismatches with the previous action call and /${constants.ON_STATUS}_${state}`,
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

  if (
    flow === FLOW.FLOW2A &&
    order.payment?.status !== PAYMENT_STATUS.NOT_PAID
  ) {
    result.push(
      addError(
        `Payment status should be ${PAYMENT_STATUS.NOT_PAID} for ${FLOW.FLOW2A} flow (Cash on Delivery)`,
        ERROR_CODES.INVALID_RESPONSE
      )
    );
  }

  const settlement_details: any =
    order?.payment["@ondc/org/settlement_details"];

  const storedSettlementRaw = await RedisService.getKey(
    `${transaction_id}_settlementDetailSet`
  );

  const storedSettlementSet = storedSettlementRaw
    ? JSON.parse(storedSettlementRaw)
    : null;

  storedSettlementSet?.forEach((obj1: any) => {
    const exist = settlement_details.some((obj2: any) => _.isEqual(obj1, obj2));
    if (!exist) {
      result.push({
        valid: false,
        code: 20006,
        description: `Missing payment/@ondc/org/settlement_details as compared to previous calls or not captured correctly: ${JSON.stringify(
          obj1
        )}`,
      });
    }
  });
}

async function validateQuote(
  order: any,
  transaction_id: string,
  state: string,
  result: ValidationError[]
): Promise<void> {
  if (!sumQuoteBreakUp(order.quote)) {
    result.push(
      addError(
        `item quote breakup prices for ${constants.ON_STATUS}_${state} should be equal to the total price`,
        ERROR_CODES.INVALID_RESPONSE
      )
    );
  }

  validateOfferQuoteBreakup(order, result);

  const quoteObjRaw = await RedisService.getKey(`${transaction_id}_quoteObj`);
  const previousQuote = quoteObjRaw ? JSON.parse(quoteObjRaw) : null;
  const quoteErrors = compareQuoteObjects(
    previousQuote,
    order.quote,
    constants.ON_STATUS,
    "previous action call"
  );
  if (quoteErrors) {
    quoteErrors.forEach((error: string) =>
      result.push(addError(error, ERROR_CODES.INVALID_RESPONSE))
    );
  }
}

async function validateBilling(
  order: any,
  transaction_id: string,
  state: string,
  result: ValidationError[]
): Promise<void> {
  const billingRaw = await RedisService.getKey(`${transaction_id}_billing`);
  const billing = billingRaw ? JSON.parse(billingRaw) : null;
  const billingErrors = compareObjects(billing, order.billing);
  if (billingErrors) {
    billingErrors.forEach((error: string) =>
      result.push(
        addError(
          `${error} when compared with confirm billing object`,
          ERROR_CODES.INVALID_RESPONSE
        )
      )
    );
  }
}

async function validateTags(
  order: any,
  transaction_id: string,
  state: string,
  result: ValidationError[]
): Promise<void> {
  const bpp_terms_obj = order.tags?.find(
    (item: any) => item?.code === "bpp_terms"
  );
  const list = bpp_terms_obj?.list || [];
  const np_type_arr = list.filter((item: any) => item.code === "np_type");
  const np_type_on_search = await RedisService.getKey(
    `${transaction_id}_${ApiSequence.ON_SEARCH}np_type`
  );

  let tax_number = "";
  let provider_tax_number = "";
  list.forEach((item: any) => {
    if (item.code === "tax_number") {
      if (item.value.length !== 15) {
        result.push(
          addError(
            `Number of digits in tax number in message.order.tags[0].list should be 15`,
            ERROR_CODES.INVALID_RESPONSE
          )
        );
      } else {
        tax_number = item.value;
        const taxNumberPattern =
          /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;
        if (!taxNumberPattern.test(tax_number)) {
          result.push(
            addError(
              `Invalid format for tax_number in ${constants.ON_STATUS}_${state}`,
              ERROR_CODES.INVALID_RESPONSE
            )
          );
        }
      }
    }
    if (item.code === "provider_tax_number") {
      if (item.value.length !== 10) {
        result.push(
          addError(
            `Number of digits in provider tax number in message.order.tags[0].list should be 10`,
            ERROR_CODES.INVALID_RESPONSE
          )
        );
      } else {
        provider_tax_number = item.value;
        const taxNumberPattern = /^[A-Z]{5}[0-9]{4}[A-Z]{1}$/;
        if (!taxNumberPattern.test(provider_tax_number)) {
          result.push(
            addError(
              `Invalid format for provider_tax_number in ${constants.ON_STATUS}_${state}`,
              ERROR_CODES.INVALID_RESPONSE
            )
          );
        }
      }
    }
  });

  if (tax_number.length === 15 && provider_tax_number.length === 10) {
    const pan_id = tax_number.slice(2, 12);
    if (pan_id !== provider_tax_number && np_type_on_search === "ISN") {
      result.push(
        addError(
          `Pan_id is different in tax_number and provider_tax_number in message.order.tags[0].list`,
          ERROR_CODES.INVALID_RESPONSE
        )
      );
    } else if (pan_id === provider_tax_number && np_type_on_search === "MSN") {
      result.push(
        addError(
          `Pan_id shouldn't be same in tax_number and provider_tax_number in message.order.tags[0].list`,
          ERROR_CODES.INVALID_RESPONSE
        )
      );
    }
  }

  const confirm_tagsRaw = await RedisService.getKey(
    `${transaction_id}_confirm_tags`
  );
  const confirm_tags = confirm_tagsRaw ? JSON.parse(confirm_tagsRaw) : null;
  if (order.tags && confirm_tags) {
    // if (!areGSTNumbersMatching(confirm_tags, order.tags, "bpp_terms")) {
    //   result.push(
    //     addError(
    //       `Tags should have same and valid gst_number as passed in /${constants.CONFIRM}`,
    //       ERROR_CODES.INVALID_RESPONSE
    //     )
    //   );
    // }
  }
}

async function validateItems(
  transactionId: any,
  items: any,
  result: any,
  options = {
    currentApi: ApiSequence.INIT,
    previousApi: ApiSequence.ON_SELECT,
    checkQuantity: true,
    checkTags: true,
  }
) {
  const {
    currentApi,
    previousApi = ApiSequence.ON_CONFIRM,
    checkQuantity = true,
    checkTags = true,
  } = options;

  try {
    // Fetch required data from Redis
    const redisKeys = [
      RedisService.getKey(`${transactionId}_itemFlfllmnts`),
      RedisService.getKey(`${transactionId}_itemsIdList`),
    ];

    const [itemFlfllmntsRaw, itemsIdListRaw] = await Promise.all(redisKeys);

    const itemFlfllmnts = itemFlfllmntsRaw
      ? JSON.parse(itemFlfllmntsRaw)
      : null;
    const itemsIdList = itemsIdListRaw ? JSON.parse(itemsIdListRaw) : null;

    // Validate each item
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const itemId = item.id;

      // Check if item ID exists
      if (!itemId) {
        result.push({
          valid: false,
          code: 20000,
          description: `items[${i}].id is missing in /${currentApi}`,
        });
        continue;
      }

      // Validate item ID existence in /on_select
      if (!itemFlfllmnts || !(itemId in itemFlfllmnts)) {
        result.push({
          valid: false,
          code: 20000,
          description: `Item Id ${itemId} does not exist in /${previousApi}`,
        });
        continue;
      }
    }

    return result;
  } catch (error: any) {
    console.error(
      `!!Error while validating items in /${currentApi}: ${error.stack}`
    );
    result.push({
      valid: false,
      code: 20000,
      description: `Error occurred while validating items in /${currentApi}`,
    });
    return result;
  }
}

const checkOnStatusAgentAssigned = async (
  payload: any,
  state: any,
  fulfillmentsItemsSet: any
) => {
  const result: any = [];

  try {
    const data = structuredClone(payload)
    const { context, message } = data;
    try {
      await contextChecker(
        context,
        result,
        ApiSequence.ON_STATUS_AGENT_ASSIGNED,
        constants.ON_STATUS_PENDING,
        true
      );
    } catch (err: any) {
      result.push(addError(`Error checking context: ${err.message}`, 20000));

      return result;
    }

    const flow = (await RedisService.getKey("flow")) || "2";
    const { transaction_id } = context;
    const order = message.order;

    await Promise.all([
      validateOrder(order, transaction_id, state, result),
      validateFulfillments(
        order,
        transaction_id,
        state,
        fulfillmentsItemsSet,
        result
      ),
      validateTimestamps(order, context, transaction_id, state, result),
      validatePayment(order, transaction_id, flow, state, result),
      validateQuote(order, transaction_id, state, result),
      validateBilling(order, transaction_id, state, result),
      validateItems(transaction_id, order.items, result),
      validateTags(order, transaction_id, state, result),
      RedisService.setKey(
        `${transaction_id}_${ApiSequence.ON_STATUS_AGENT_ASSIGNED}`,
        JSON.stringify(data),
        TTL_IN_SECONDS
      ),
    ]);

    return result;
  } catch (err: any) {
    console.error(
      `!!Some error occurred while checking /${constants.ON_STATUS} API, ${err.stack}`
    );
    result.push(
      addError(
        "Internal Error - The response could not be processed due to an internal error. The SNP should retry the request.",
        ERROR_CODES.INTERNAL_ERROR
      )
    );
    return result;
  }
};

export default checkOnStatusAgentAssigned;
