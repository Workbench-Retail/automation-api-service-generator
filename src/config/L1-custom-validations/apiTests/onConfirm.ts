/* eslint-disable no-prototype-builtins */
import _ from "lodash";
import { RedisService } from "ondc-automation-cache-lib";
import {
  areGSTNumbersMatching,
  checkBppIdOrBapId,
  checkContext,
  checkItemTag,
  compareCoordinates,
  compareLists,
  compareObjects,
  compareQuoteObjects,
  FLOW,
  isObjectEmpty,
  isoDurToSec,
  sumQuoteBreakUp,
  timeDiff as timeDifference,
  payment_status,
  addFulfillmentIdToRedisSet,
  addActionToRedisSet,
} from "../utils/helper";
import constants, {
  ApiSequence,
  PAYMENT_STATUS,
} from "../utils/constants";

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
  INVALID_CANCELLATION_TERMS: 22505, // Cancellation terms differ from quoted
  INTERNAL_ERROR: 23001, // Internal processing error (retryable)
  ORDER_VALIDATION_FAILURE: 23002, // Order validation failed
  OFFER_FULFILLMENT_ERROR: 30007, // Offer cannot be fulfilled
  ORDER_CONFIRM_FAILURE: 30020, // No response from BNP
  INTERNAL_ERROR_SNP: 31001, // Internal error on SNP side (retryable)
};
const TTL_IN_SECONDS: number = Number(process.env.TTL_IN_SECONDS) || 3600;
// Utility function to create error objects
const createError = (description: string, code: number): ValidationError => ({
  valid: false,
  code,
  description,
});

// Validation functions
async function validateContext(
  context: any,
  transaction_id: string,
  result: ValidationError[]
): Promise<void> {
  const contextRes = checkContext(context, constants.ON_CONFIRM);
  if (!contextRes?.valid) {
    contextRes?.ERRORS.forEach((error: string) =>
      result.push(createError(error, ERROR_CODES.INVALID_RESPONSE))
    );
  }

  if (checkBppIdOrBapId(context.bap_id)) {
    result.push(
      createError(
        "context/bap_id should not be a url",
        ERROR_CODES.INVALID_RESPONSE
      )
    );
  }
  if (checkBppIdOrBapId(context.bpp_id)) {
    result.push(
      createError(
        "context/bpp_id should not be a url",
        ERROR_CODES.INVALID_RESPONSE
      )
    );
  }

  const domain = await RedisService.getKey(`${transaction_id}_domain`);
  if (!_.isEqual(context.domain?.split(":")[1], domain)) {
    result.push(
      createError(
        "Domain should be same in each action",
        ERROR_CODES.INVALID_RESPONSE
      )
    );
  }

  const searchContextRaw = await RedisService.getKey(
    `${transaction_id}_${ApiSequence.SEARCH}_context`
  );
  const searchContext = searchContextRaw ? JSON.parse(searchContextRaw) : null;
  if (searchContext && !_.isEqual(searchContext.city, context.city)) {
    result.push(
      createError(
        `City code mismatch in /${constants.SEARCH} and /${constants.ON_CONFIRM}`,
        ERROR_CODES.INVALID_RESPONSE
      )
    );
  }
}

async function validateMessageId(
  context: any,
  transaction_id: string,
  result: ValidationError[]
): Promise<void> {
  try {
    const confirmMsgId = await RedisService.getKey(
      `${transaction_id}_${ApiSequence.CONFIRM}_msgId`
    );
    const domain = await RedisService.getKey(`${transaction_id}_domain`);
    console.log("domain", domain, context.domain.split(":")[1]);

    console.log("diff", confirmMsgId, context.message_id);
    if (!_.isEqual(confirmMsgId, context.message_id)) {
      result.push(
        createError(
          `Message Ids for /${constants.CONFIRM} and /${constants.ON_CONFIRM} api should be same`,
          ERROR_CODES.OUT_OF_SEQUENCE
        )
      );
    }
  } catch (error: any) {
    console.error(
      `!!Error while checking message id for /${constants.ON_CONFIRM}, ${error.stack}`
    );
    result.push(
      createError(
        "Internal error while checking message ID",
        ERROR_CODES.INTERNAL_ERROR
      )
    );
  }
}

async function validateTimestamp(
  context: any,
  transaction_id: string,
  result: ValidationError[]
): Promise<void> {
  try {
    const tmpstmpRaw = await RedisService.getKey(
      `${transaction_id}_${ApiSequence.CONFIRM}_tmpstmp`
    );

    const tmpstmp = tmpstmpRaw ? JSON.parse(tmpstmpRaw) : null;
    if (tmpstmp && _.gte(tmpstmp, context.timestamp)) {
      result.push(
        createError(
          `Timestamp for /${constants.CONFIRM} api cannot be greater than or equal to /${constants.ON_CONFIRM} api`,
          ERROR_CODES.OUT_OF_SEQUENCE
        )
      );
    } else if (tmpstmp) {
      const timeDiff = timeDifference(context.timestamp, tmpstmp);
      if (timeDiff > 5000) {
        result.push(
          createError(
            `context/timestamp difference between /${constants.ON_CONFIRM} and /${constants.CONFIRM} should be less than 5 sec`,
            ERROR_CODES.TIMEOUT
          )
        );
      }
    }
    await Promise.all([
      RedisService.setKey(
        `${transaction_id}_${ApiSequence.ON_CONFIRM}_tmpstmp`,
        JSON.stringify(context.timestamp),
        TTL_IN_SECONDS
      ),
    ]);
  } catch (error: any) {
    console.error(
      `Error while comparing timestamp for /${constants.CONFIRM} and /${constants.ON_CONFIRM} api, ${error.stack}`
    );
    result.push(
      createError(
        "Internal error while checking timestamp",
        ERROR_CODES.INTERNAL_ERROR
      )
    );
  }
}

async function validateOrder(
  order: any,
  transaction_id: string,
  select_customIdArray: any,
  parentItemIdSet: any,
  result: ValidationError[]
): Promise<void> {
  const cnfrmOrdrIdRaw = await RedisService.getKey(
    `${transaction_id}_cnfrmOrdrId`
  );
  const cnfrmOrdrId = cnfrmOrdrIdRaw ? JSON.parse(cnfrmOrdrIdRaw) : null;
  if (cnfrmOrdrId && cnfrmOrdrId !== order.id) {
    result.push(
      createError(
        `Order Id mismatches in /${constants.CONFIRM} and /${constants.ON_CONFIRM}`,
        ERROR_CODES.INVALID_RESPONSE
      )
    );
  }

  if (order.cancellation_terms && order.cancellation_terms.length > 0) {
    result.push(
      createError(
        `'cancellation_terms' in /message/order should not be provided as those are not enabled yet`,
        ERROR_CODES.INVALID_CANCELLATION_TERMS
      )
    );
  }

  const cnfrmOrdrCrtdRaw = await RedisService.getKey(
    `${transaction_id}_ordrCrtd`
  );
  const cnfrmOrdrCrtd = cnfrmOrdrCrtdRaw ? JSON.parse(cnfrmOrdrCrtdRaw) : null;
  const cnfrmOrdrUpdtdRaw = await RedisService.getKey(
    `${transaction_id}_ordrUpdtd`
  );
  const cnfrmOrdrUpdtd = cnfrmOrdrUpdtdRaw
    ? JSON.parse(cnfrmOrdrUpdtdRaw)
    : null;

  if (!_.isEmpty(order.state)) {
    await Promise.all([
      RedisService.setKey(
        `${transaction_id}_orderState`,
        JSON.stringify(order.state),
        TTL_IN_SECONDS
      ),
      RedisService.setKey(
        `${transaction_id}_onCnfrmState`,
        JSON.stringify(order.state),
        TTL_IN_SECONDS
      ),
    ]);
  }

  if (order.state === "Created" || order.state === "Accepted") {
    if (
      cnfrmOrdrCrtd &&
      (!order.created_at || order.created_at !== cnfrmOrdrCrtd)
    ) {
      result.push(
        createError(
          `order.created_at timestamp mismatches in /${constants.CONFIRM} and /${constants.ON_CONFIRM}`,
          ERROR_CODES.INVALID_RESPONSE
        )
      );
    }
    if (order.updated_at) {
      await RedisService.setKey(
        `${transaction_id}_PreviousUpdatedTimestamp`,
        JSON.stringify(order.updated_at),
        TTL_IN_SECONDS
      );
    }
    if (
      cnfrmOrdrUpdtd &&
      (!order.updated_at || _.gte(cnfrmOrdrUpdtd, order.updated_at))
    ) {
      result.push(
        createError(
          `order.updated_at timestamp should be updated as per the context.timestamp`,
          ERROR_CODES.INVALID_RESPONSE
        )
      );
    }
  } else {
    result.push(
      createError(
        `Invalid order state: ${order.state}`,
        ERROR_CODES.INVALID_ORDER_STATE
      )
    );
  }

  const [providerIdRaw, providerLocRaw, itemFlfllmntsRaw, itemsIdListRaw] =
    await Promise.all([
      RedisService.getKey(`${transaction_id}_providerId`),
      RedisService.getKey(`${transaction_id}_providerLoc`),
      RedisService.getKey(`${transaction_id}_itemFlfllmnts`),
      RedisService.getKey(`${transaction_id}_itemsIdList`),
    ]);
  const providerId = providerIdRaw ? JSON.parse(providerIdRaw) : null;
  const providerLoc = providerLocRaw ? JSON.parse(providerLocRaw) : null;
  const itemFlfllmnts = itemFlfllmntsRaw ? JSON.parse(itemFlfllmntsRaw) : null;
  const itemsIdList = itemsIdListRaw ? JSON.parse(itemsIdListRaw) : null;

  if (providerId && order.provider?.id !== providerId) {
    result.push(
      createError(
        `Provider Id mismatches in /${constants.ON_SEARCH} and /${constants.ON_CONFIRM}`,
        ERROR_CODES.INVALID_RESPONSE
      )
    );
  }
  if (providerLoc && order.provider?.locations?.[0]?.id !== providerLoc) {
    result.push(
      createError(
        `provider.locations[0].id mismatches in /${constants.ON_SEARCH} and /${constants.ON_CONFIRM}`,
        ERROR_CODES.INVALID_RESPONSE
      )
    );
  }

  order.items?.forEach((item: any, index: number) => {
    if (checkItemTag(item, select_customIdArray)) {
      result.push(
        createError(
          `items[${index}].tags.parent_id mismatches for Item ${item.id} in /${constants.SELECT} and /${constants.ON_CONFIRM}`,
          ERROR_CODES.INVALID_RESPONSE
        )
      );
    }
    if (
      parentItemIdSet &&
      item.parent_item_id &&
      !parentItemIdSet.includes(item.parent_item_id)
    ) {
      result.push(
        createError(
          `items[${index}].parent_item_id mismatches for Item ${item.id} in /${constants.ON_SEARCH} and /${constants.ON_CONFIRM}`,
          ERROR_CODES.INVALID_RESPONSE
        )
      );
    }
    if (itemFlfllmnts && item.id in itemFlfllmnts) {
      if (item.fulfillment_id !== itemFlfllmnts[item.id]) {
        result.push(
          createError(
            `items[${index}].fulfillment_id mismatches for Item ${item.id} in /${constants.ON_SELECT} and /${constants.ON_CONFIRM}`,
            ERROR_CODES.INVALID_RESPONSE
          )
        );
      }
    } else {
      result.push(
        createError(
          `Item Id ${item.id} does not exist in /${constants.ON_SELECT}`,
          ERROR_CODES.INVALID_RESPONSE
        )
      );
    }
    if (
      itemsIdList &&
      item.id in itemsIdList &&
      item.quantity?.count !== itemsIdList[item.id]
    ) {
      result.push(
        createError(
          `Warning: items[${index}].quantity.count for item ${item.id} mismatches with the items quantity selected in /${constants.SELECT}`,
          ERROR_CODES.INVALID_RESPONSE
        )
      );
    }
  });
}

async function validateFulfillments(
  order: any,
  transaction_id: string,
  result: ValidationError[]
): Promise<void> {
  const [
    itemFlfllmntsRaw,
    providerGpsRaw,
    providerNameRaw,
    buyerGpsRaw,
    buyerAddrRaw,
  ] = await Promise.all([
    RedisService.getKey(`${transaction_id}_itemFlfllmnts`),
    RedisService.getKey(`${transaction_id}_providerGps`),
    RedisService.getKey(`${transaction_id}_providerName`),
    RedisService.getKey(`${transaction_id}_buyerGps`),
    RedisService.getKey(`${transaction_id}_buyerAddr`),
  ]);
  const itemFlfllmnts = itemFlfllmntsRaw ? JSON.parse(itemFlfllmntsRaw) : null;
  const providerGps = providerGpsRaw ? JSON.parse(providerGpsRaw) : null;
  const providerName = providerNameRaw ? JSON.parse(providerNameRaw) : null;
  const buyerGps = buyerGpsRaw ? JSON.parse(buyerGpsRaw) : null;
  const buyerAddr = buyerAddrRaw ? JSON.parse(buyerAddrRaw) : null;

  for (const fulfillment of order.fulfillments || []) {
    if (!fulfillment["@ondc/org/TAT"]) {
      result.push(
        createError(
          `'TAT' must be provided in message/order/fulfillments[${fulfillment.id}]`,
          ERROR_CODES.INVALID_RESPONSE
        )
      );
    }

    const on_select_fulfillment_tat_objRaw = await RedisService.getKey(
      `${transaction_id}_fulfillment_tat_obj`
    );
    const on_select_fulfillment_tat_obj = on_select_fulfillment_tat_objRaw
      ? JSON.parse(on_select_fulfillment_tat_objRaw)
      : null;
    if (
      on_select_fulfillment_tat_obj &&
      on_select_fulfillment_tat_obj[fulfillment.id] !==
      isoDurToSec(fulfillment["@ondc/org/TAT"])
    ) {
      result.push(
        createError(
          `TAT Mismatch between /${constants.ON_CONFIRM} i.e ${isoDurToSec(
            fulfillment["@ondc/org/TAT"]
          )} seconds & /${constants.ON_SELECT} i.e ${on_select_fulfillment_tat_obj[fulfillment.id]
          } seconds`,
          ERROR_CODES.INVALID_RESPONSE
        )
      );
    }

    if (
      !fulfillment.id ||
      !itemFlfllmnts ||
      !Object.values(itemFlfllmnts).includes(fulfillment.id)
    ) {
      result.push(
        createError(
          `fulfillment id ${fulfillment.id || "missing"} does not exist in /${constants.ON_SELECT
          }`,
          ERROR_CODES.INVALID_RESPONSE
        )
      );
    }

    if (!fulfillment.type) {
      result.push(
        createError(
          `fulfillment type does not exist in /${constants.ON_CONFIRM}`,
          ERROR_CODES.INVALID_RESPONSE
        )
      );
    }

    const ffTrackingRaw = await RedisService.getKey(
      `${transaction_id}_${fulfillment.id}_tracking`
    );
    const ffTracking = ffTrackingRaw ? JSON.parse(ffTrackingRaw) : null;
    if (ffTracking) {
      if (typeof fulfillment.tracking !== "boolean") {
        result.push(
          createError(
            `Tracking must be present for fulfillment ID: ${fulfillment.id} in boolean form`,
            ERROR_CODES.INVALID_RESPONSE
          )
        );
      } else if (ffTracking !== fulfillment.tracking) {
        result.push(
          createError(
            `Fulfillment Tracking mismatch with the ${constants.ON_SELECT} call`,
            ERROR_CODES.INVALID_RESPONSE
          )
        );
      }
    }

    const ffDesc = fulfillment.state?.descriptor;
    const ffStateCheck =
      ffDesc?.hasOwnProperty("code") && ffDesc.code === "Pending";
    await RedisService.setKey(
      `${transaction_id}_ffIdPrecancel`,
      JSON.stringify(ffDesc?.code),
      TTL_IN_SECONDS
    );
    if (!ffStateCheck) {
      result.push(
        createError(
          `default fulfillments state is missing in /${constants.ON_CONFIRM}`,
          ERROR_CODES.INVALID_ORDER_STATE
        )
      );
    }

    if (!fulfillment.start || !fulfillment.end) {
      result.push(
        createError(
          `fulfillments[${fulfillment.id}] start and end locations are mandatory`,
          ERROR_CODES.INVALID_RESPONSE
        )
      );
    }

    if (
      fulfillment.start?.location?.gps &&
      !compareCoordinates(fulfillment.start.location.gps, providerGps)
    ) {
      result.push(
        createError(
          `store gps location /fulfillments[${fulfillment.id}]/start/location/gps can't change`,
          ERROR_CODES.INVALID_RESPONSE
        )
      );
    }

    if (
      !providerName ||
      !_.isEqual(fulfillment.start?.location?.descriptor?.name, providerName)
    ) {
      result.push(
        createError(
          `store name /fulfillments[${fulfillment.id}]/start/location/descriptor/name can't change`,
          ERROR_CODES.INVALID_RESPONSE
        )
      );
    }

    if (
      fulfillment.end?.location?.gps &&
      !_.isEqual(fulfillment.end.location.gps, buyerGps)
    ) {
      result.push(
        createError(
          `fulfillments[${fulfillment.id}].end.location gps is not matching with gps in /${constants.SELECT}`,
          ERROR_CODES.INVALID_RESPONSE
        )
      );
    }

    if (
      fulfillment.end?.location?.address?.area_code &&
      !_.isEqual(fulfillment.end.location.address.area_code, buyerAddr)
    ) {
      result.push(
        createError(
          `fulfillments[${fulfillment.id}].end.location.address.area_code is not matching with area_code in /${constants.SELECT}`,
          ERROR_CODES.INVALID_RESPONSE
        )
      );
    }
  }

  order.fulfillments?.forEach((fulfillment: any, index: number) => {
    const type = fulfillment.type;
    const category = fulfillment["@ondc/org/category"];
    const vehicle = fulfillment.vehicle;
    const SELF_PICKUP = "Self-Pickup";
    const KERBSIDE = "Kerbside";

    if (type === SELF_PICKUP && category === KERBSIDE) {
      if (!vehicle) {
        result.push(
          createError(
            `Vehicle is required for fulfillment ${index} with type ${SELF_PICKUP} and category ${KERBSIDE} in /${constants.ON_CONFIRM}`,
            ERROR_CODES.INVALID_RESPONSE
          )
        );
      } else if (!vehicle.registration) {
        result.push(
          createError(
            `Vehicle registration is required for fulfillment ${index} with type ${SELF_PICKUP} and category ${KERBSIDE} in /${constants.ON_CONFIRM}`,
            ERROR_CODES.INVALID_RESPONSE
          )
        );
      }
    } else if (vehicle) {
      result.push(
        createError(
          `Vehicle should not be present in fulfillment ${index} with type ${type} and category ${category} in /${constants.ON_CONFIRM}`,
          ERROR_CODES.INVALID_RESPONSE
        )
      );
    }
  });

  const deliveryFulfillment = (order.fulfillments || []).filter(
    (f: any) => f.type === "Delivery"
  );
  if (
    deliveryFulfillment.length > 0 &&
    deliveryFulfillment[0].start?.time?.range &&
    deliveryFulfillment[0].end?.time?.range
  ) {
    await Promise.all([
      RedisService.setKey(
        `${transaction_id}_deliveryFulfillment`,
        JSON.stringify(deliveryFulfillment[0]),
        TTL_IN_SECONDS
      ),
      RedisService.setKey(
        `${transaction_id}_deliveryFulfillmentAction`,
        JSON.stringify(ApiSequence.ON_CONFIRM),
        TTL_IN_SECONDS
      ),
    ]);
  }

  if (order.state === "Accepted") {
    if (!order.fulfillments?.length) {
      result.push(
        createError(
          `missingFulfillments is mandatory for ${ApiSequence.ON_CONFIRM}`,
          ERROR_CODES.ORDER_VALIDATION_FAILURE
        )
      );
    } else {
      const deliveryObjArr = order.fulfillments.filter(
        (f: any) => f.type === "Delivery"
      );
      if (!deliveryObjArr.length) {
        result.push(
          createError(
            `Delivery fulfillment must be present in ${ApiSequence.ON_CONFIRM} if the Order.state is 'Accepted'`,
            ERROR_CODES.ORDER_VALIDATION_FAILURE
          )
        );
      } else {
        const deliverObj = { ...deliveryObjArr[0] };
        delete deliverObj?.state;
        delete deliverObj?.tags;
        delete deliverObj?.start?.instructions;
        delete deliverObj?.end?.instructions;
        await addFulfillmentIdToRedisSet(
          transaction_id,
          JSON.stringify(deliverObj)
        );
      }
    }
  }
  await RedisService.setKey('fulfillmentsItemsSet', JSON.stringify(order?.fulfillments[0]), TTL_IN_SECONDS);
}

async function validatePayment(
  order: any,
  transaction_id: string,
  flow: string,
  result: ValidationError[]
): Promise<void> {
  if (
    parseFloat(order.payment?.params?.amount) !==
    parseFloat(order.quote?.price?.value)
  ) {
    result.push(
      createError(
        `Quoted price (/${constants.ON_CONFIRM}) doesn't match with the amount in payment.params`,
        ERROR_CODES.INVALID_RESPONSE
      )
    );
  }

  const cnfrmpymntRaw = await RedisService.getKey(
    `${transaction_id}_cnfrmpymnt`
  );
  const cnfrmpymnt = cnfrmpymntRaw ? JSON.parse(cnfrmpymntRaw) : null;
  if (cnfrmpymnt && !_.isEqual(cnfrmpymnt, order.payment)) {
    result.push(
      createError(
        `payment object mismatches in /${constants.CONFIRM} & /${constants.ON_CONFIRM}`,
        ERROR_CODES.INVALID_RESPONSE
      )
    );
  }

  const buyerFFRaw = await RedisService.getKey(
    `${transaction_id}_${ApiSequence.SEARCH}_buyerFF`
  );
  const buyerFF = buyerFFRaw ? JSON.parse(buyerFFRaw) : null;
  if (
    order.payment?.["@ondc/org/buyer_app_finder_fee_amount"] &&
    parseFloat(order.payment["@ondc/org/buyer_app_finder_fee_amount"]) !==
    buyerFF
  ) {
    result.push(
      createError(
        `Buyer app finder fee can't change in /${constants.ON_CONFIRM}`,
        ERROR_CODES.INVALID_RESPONSE
      )
    );
  }

  if (flow !== FLOW.FLOW2A) {
    const status = payment_status(order.payment, flow);
    if (!status) {
      result.push(
        createError(
          `Transaction_id missing in message/order/payment`,
          ERROR_CODES.INVALID_RESPONSE
        )
      );
    }
  }

  if (
    flow === FLOW.FLOW2A &&
    order.payment?.status !== PAYMENT_STATUS.NOT_PAID
  ) {
    result.push(
      createError(
        `Payment status should be ${PAYMENT_STATUS.NOT_PAID} for ${FLOW.FLOW2A} flow (Cash on Delivery)`,
        ERROR_CODES.INVALID_RESPONSE
      )
    );
  }
}

async function validateQuote(
  order: any,
  transaction_id: string,
  result: ValidationError[]
): Promise<void> {
  if (!sumQuoteBreakUp(order.quote)) {
    result.push(
      createError(
        `item quote breakup prices for ${constants.ON_CONFIRM} should be equal to the total price`,
        ERROR_CODES.INVALID_RESPONSE
      )
    );
  }

  const quoteObjRaw = await RedisService.getKey(`${transaction_id}_quoteObj`);
  const on_select_quote = quoteObjRaw ? JSON.parse(quoteObjRaw) : null;

  const quoteErrors = compareQuoteObjects(
    on_select_quote,
    order.quote,
    constants.ON_CONFIRM,
    constants.ON_SELECT
  );
  if (quoteErrors) {
    quoteErrors.forEach((error: string) =>
      result.push(createError(error, ERROR_CODES.INVALID_RESPONSE))
    );
  }

  const hasItemWithQuantity = _.some(order.quote?.breakup, (item: any) =>
    _.has(item, "item.quantity")
  );
  if (hasItemWithQuantity) {
    result.push(
      createError(
        `Extra attribute Quantity provided in quote object i.e not supposed to be provided after on_select so invalid quote object`,
        ERROR_CODES.INVALID_RESPONSE
      )
    );
  }

  const initQuotePriceRaw = await RedisService.getKey(
    `${transaction_id}_initQuotePrice`
  );
  const oninitQuotePrice = initQuotePriceRaw
    ? JSON.parse(initQuotePriceRaw)
    : null;
  const onConfirmQuotePrice = parseFloat(order.quote?.price?.value);
  if (oninitQuotePrice && oninitQuotePrice !== onConfirmQuotePrice) {
    result.push(
      createError(
        `Quoted Price in /${constants.ON_CONFIRM} INR ${onConfirmQuotePrice} does not match with the quoted price in /${constants.ON_INIT} INR ${oninitQuotePrice}`,
        ERROR_CODES.INVALID_RESPONSE
      )
    );
  }

  await RedisService.setKey(
    `${transaction_id}_quotePrice`,
    JSON.stringify(onConfirmQuotePrice),
    TTL_IN_SECONDS
  );
}

async function validateTags(
  order: any,
  transaction_id: string,
  context: any,
  result: ValidationError[]
): Promise<void> {
  const bpp_terms_obj = order.tags?.find(
    (item: any) => item?.code === "bpp_terms"
  );
  const list = bpp_terms_obj?.list || [];
  const np_type_arr = list.filter((item: any) => item.code === "np_type");
  const accept_bap_terms = list.filter(
    (item: any) => item.code === "accept_bap_terms"
  );
  const np_type_on_search = await RedisService.getKey(
    `${transaction_id}_${ApiSequence.ON_SEARCH}np_type`
  );

  if (np_type_arr.length === 0) {
    result.push(
      createError(
        `np_type not found in ${constants.ON_CONFIRM}`,
        ERROR_CODES.INVALID_RESPONSE
      )
    );
  } else {
    const np_type = np_type_arr[0].value;
    if (np_type !== np_type_on_search) {
      result.push(
        createError(
          `np_type of ${constants.ON_SEARCH} is not same to np_type of ${constants.ON_CONFIRM}`,
          ERROR_CODES.INVALID_RESPONSE
        )
      );
    }
  }

  if (accept_bap_terms.length > 0) {
    result.push(
      createError(
        `accept_bap_terms is not required for now`,
        ERROR_CODES.INVALID_RESPONSE
      )
    );
  }

  let tax_number = "";
  let provider_tax_number = "";
  list.forEach((item: any) => {
    if (item.code === "tax_number") {
      if (item.value.length !== 15) {
        result.push(
          createError(
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
            createError(
              `Invalid format for tax_number in ${constants.ON_CONFIRM}`,
              ERROR_CODES.INVALID_RESPONSE
            )
          );
        }
      }
    }
    if (item.code === "provider_tax_number") {
      if (item.value.length !== 10) {
        result.push(
          createError(
            `Number of digits in provider tax number in message.order.tags[0].list should be 10`,
            ERROR_CODES.INVALID_RESPONSE
          )
        );
      } else {
        provider_tax_number = item.value;
        const taxNumberPattern = /^[A-Z]{5}[0-9]{4}[A-Z]{1}$/;
        if (!taxNumberPattern.test(provider_tax_number)) {
          result.push(
            createError(
              `Invalid format for provider_tax_number in ${constants.ON_CONFIRM}`,
              ERROR_CODES.INVALID_RESPONSE
            )
          );
        }
      }
    }
  });

  if (!tax_number) {
    result.push(
      createError(
        `tax_number must be present for ${constants.ON_CONFIRM}`,
        ERROR_CODES.INVALID_RESPONSE
      )
    );
  }
  if (!provider_tax_number) {
    result.push(
      createError(
        `provider_tax_number must be present for ${constants.ON_CONFIRM}`,
        ERROR_CODES.INVALID_RESPONSE
      )
    );
  }

  if (tax_number.length === 15 && provider_tax_number.length === 10) {
    const pan_id = tax_number.slice(2, 12);
    if (pan_id !== provider_tax_number && np_type_on_search === "ISN") {
      result.push(
        createError(
          `Pan_id is different in tax_number and provider_tax_number in message.order.tags[0].list`,
          ERROR_CODES.INVALID_RESPONSE
        )
      );
    } else if (pan_id === provider_tax_number && np_type_on_search === "MSN") {
      result.push(
        createError(
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
    if (!areGSTNumbersMatching(confirm_tags, order.tags, "bap_terms")) {
      result.push(
        createError(
          `Tags should have same and valid gst_number as passed in /${constants.CONFIRM}`,
          ERROR_CODES.INVALID_RESPONSE
        )
      );
    }
    if (!areGSTNumbersMatching(confirm_tags, order.tags, "bpp_terms")) {
      result.push(
        createError(
          `Tags should have same and valid gst_number as passed in /${constants.CONFIRM}`,
          ERROR_CODES.INVALID_RESPONSE
        )
      );
    }
  }

  const list_ON_INITRaw = await RedisService.getKey(
    `${transaction_id}_list_ON_INIT`
  );
  const list_ON_INIT = list_ON_INITRaw ? JSON.parse(list_ON_INITRaw) : null;
  if (list_ON_INIT) {
    let ON_INIT_val = "";
    list_ON_INIT.forEach((data: any) => {
      if (data.code === "tax_number") ON_INIT_val = data.value;
    });

    const list_ON_CONFIRM = bpp_terms_obj?.list || [];
    if (!list_ON_CONFIRM.some((data: any) => data.code === "np_type")) {
      result.push(
        createError(
          `np_type is missing in message/order/tags/bpp_terms for ${constants.ON_CONFIRM}`,
          ERROR_CODES.INVALID_RESPONSE
        )
      );
    }
    list_ON_CONFIRM.forEach((data: any) => {
      if (
        data.code === "tax_number" &&
        ON_INIT_val &&
        data.value !== ON_INIT_val
      ) {
        result.push(
          createError(
            `Value of tax Number mismatched in message/order/tags/bpp_terms for ${constants.ON_INIT} and ${constants.ON_CONFIRM}`,
            ERROR_CODES.INVALID_RESPONSE
          )
        );
      }
    });

    for (const tag of order.tags || []) {
      if (tag.code === "bpp_terms") {
        const compareResult = compareLists(tag.list, list_ON_INIT);
        if (compareResult.length > 0) {
          result.push(
            createError(
              `List of bpp_terms mismatched in message/order/tags/bpp_terms for ${constants.ON_INIT} and ${constants.ON_CONFIRM}: ${compareResult}`,
              ERROR_CODES.INVALID_RESPONSE
            )
          );
        }
      }
    }
  }

  for (const tag of order.tags || []) {
    if (
      tag.code === "bap_terms" &&
      tag.list.some((item: any) => item.code === "static_terms")
    ) {
      result.push(
        createError(
          `static_terms is not required for now in ${constants.ON_CONFIRM}`,
          ERROR_CODES.INVALID_RESPONSE
        )
      );
    }
  }

  if (!_.isEqual(context.timestamp, order.updated_at)) {
    result.push(
      createError(
        `updated_at timestamp should be equal to context timestamp for /${constants.ON_CONFIRM}`,
        ERROR_CODES.INVALID_RESPONSE
      )
    );
  }
}
async function validateItems(
  transactionId: any,
  items: any,
  result: any,
  options = {
    currentApi: ApiSequence.INIT,
    previousApi: ApiSequence.ON_SELECT,
    checkParentItemId: true,
    checkQuantity: true,
    checkTags: true,
  }
) {
  const {
    currentApi,
    previousApi = ApiSequence.ON_CONFIRM,
    checkParentItemId = true,
    checkQuantity = true,
    checkTags = true,
  } = options;

  try {
    // Fetch required data from Redis
    const redisKeys = [
      RedisService.getKey(`${transactionId}_itemFlfllmnts`),
      RedisService.getKey(`${transactionId}_itemsIdList`),
    ];
    if (checkParentItemId) {
      redisKeys.push(RedisService.getKey(`${transactionId}_parentItemIdSet`));
    }
    if (checkTags) {
      redisKeys.push(RedisService.getKey(`${transactionId}_select_customIdArray`));
    }

    const [itemFlfllmntsRaw, itemsIdListRaw, parentItemIdSetRaw, customIdArrayRaw] = await Promise.all(redisKeys);

    const itemFlfllmnts = itemFlfllmntsRaw ? JSON.parse(itemFlfllmntsRaw) : null;
    const itemsIdList = itemsIdListRaw ? JSON.parse(itemsIdListRaw) : null;
    const parentItemIdSet = parentItemIdSetRaw ? JSON.parse(parentItemIdSetRaw) : null;
    const select_customIdArray = customIdArrayRaw ? JSON.parse(customIdArrayRaw) : null;

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

      // Validate fulfillment ID
      if (item.fulfillment_id && item.fulfillment_id !== itemFlfllmnts[itemId]) {
        result.push({
          valid: false,
          code: 20000,
          description: `items[${i}].fulfillment_id mismatches for Item ${itemId} in /${previousApi} and /${currentApi}`,
        });
      }

      // Validate quantity
      if (checkQuantity && itemsIdList && itemId in itemsIdList) {
        if (item.quantity?.count !== itemsIdList[itemId]) {
          result.push({
            valid: false,
            code: 20000,
            description: `Warning: items[${i}].quantity.count for item ${itemId} mismatches with the items quantity selected in /${constants.SELECT}`,
          });
        }
      }

      // Validate parent item ID
      if (checkParentItemId && parentItemIdSet && item.parent_item_id) {
        if (!parentItemIdSet.includes(item.parent_item_id)) {
          result.push({
            valid: false,
            code: 20000,
            description: `items[${i}].parent_item_id mismatches for Item ${itemId} in /${constants.ON_SEARCH} and /${currentApi}`,
          });
        }
      }

      // Validate custom ID tags
      if (checkTags && select_customIdArray && checkItemTag(item, select_customIdArray)) {
        result.push({
          valid: false,
          code: 20000,
          description: `items[${i}].tags.parent_id mismatches for Item ${itemId} in /${constants.ON_SEARCH} and /${currentApi}`,
        });
      }
    }

    return result;
  } catch (error: any) {
    console.error(`!!Error while validating items in /${currentApi}: ${error.stack}`);
    result.push({
      valid: false,
      code: 20000,
      description: `Error occurred while validating items in /${currentApi}`,
    });
    return result;
  }
}
async function validateBilling(
  order: any,
  transaction_id: string,
  result: ValidationError[]
): Promise<void> {
  const billingRaw = await RedisService.getKey(`${transaction_id}_billing`);
  const billing = billingRaw ? JSON.parse(billingRaw) : null;
  const billingErrors = compareObjects(billing, order.billing);
  if (billingErrors) {
    billingErrors.forEach((error: string) =>
      result.push(
        createError(
          `${error} when compared with confirm billing object`,
          ERROR_CODES.INVALID_RESPONSE
        )
      )
    );
  }
}

const onConfirm = async (data: any): Promise<ValidationError[]> => {
  const result: ValidationError[] = [];
  const flow = "2";
  try {
    if (!data || isObjectEmpty(data)) {
      result.push(
        createError("JSON cannot be empty", ERROR_CODES.INVALID_RESPONSE)
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
        createError(
          "/context, /message, /order or /message/order is missing or empty",
          ERROR_CODES.INVALID_RESPONSE
        )
      );
      return result;
    }


    const { transaction_id } = context;
    const order = message.order;

    const [parentItemIdSetRaw, select_customIdArrayRaw] = await Promise.all([
      RedisService.getKey(`${transaction_id}_parentItemIdSet`),
      RedisService.getKey(`${transaction_id}_select_customIdArray`),
    ]);
    const parentItemIdSet = parentItemIdSetRaw
      ? JSON.parse(parentItemIdSetRaw)
      : null;
    const select_customIdArray = select_customIdArrayRaw
      ? JSON.parse(select_customIdArrayRaw)
      : null;

    await Promise.all([
      validateContext(context, transaction_id, result),
      validateMessageId(context, transaction_id, result),
      validateTimestamp(context, transaction_id, result),
      validateOrder(
        order,
        transaction_id,
        select_customIdArray,
        parentItemIdSet,
        result
      ),
      validateFulfillments(order, transaction_id, result),
      validatePayment(order, transaction_id, flow, result),
      validateQuote(order, transaction_id, result),
      validateTags(order, transaction_id, context, result),
      validateItems(transaction_id, order.items, result),
      validateBilling(order, transaction_id, result),
      RedisService.setKey(
        `${transaction_id}_${ApiSequence.ON_CONFIRM}`,
        JSON.stringify(data),
        TTL_IN_SECONDS
      ),
    ]);

    return result;
  } catch (err: any) {
    console.error(
      `!!Some error occurred while checking /${constants.ON_CONFIRM} API`,
      err
    );
    result.push(
      createError(
        "Internal error processing /on_confirm request",
        ERROR_CODES.INTERNAL_ERROR
      )
    );
    return result;
  }
};

export default onConfirm;
