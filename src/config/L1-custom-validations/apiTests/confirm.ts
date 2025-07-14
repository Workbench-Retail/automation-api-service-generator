import _ from "lodash";
import { RedisService } from "ondc-automation-cache-lib";
import { contextChecker } from "./../utils/contextUtils";
import {
  compareObjects,
  compareQuoteObjects,
  getRedisValue,
  isTagsValid,
} from "./../utils/helper";
import constants, { ApiSequence } from "./../utils/constants";

const TTL_IN_SECONDS: number = Number(process.env.TTL_IN_SECONDS) || 3600;

interface ValidationError {
  valid: boolean;
  code: number;
  description: string;
}

// Helper to add error to result array
const addError = (
  result: ValidationError[],
  code: number,
  description: string
): void => {
  result.push({
    valid: false,
    code,
    description,
  });
};

// Store order details (id, timestamps)
const storeOrder = async (
  txnId: string,
  order: any,
  result: ValidationError[]
): Promise<void> => {
  try {
    await RedisService.setKey(`${txnId}_cnfrmOrdrId`, order.id, TTL_IN_SECONDS);
    if (order.created_at) {
      await RedisService.setKey(
        `${txnId}_ordrCrtd`,
        JSON.stringify(order.created_at),
        TTL_IN_SECONDS
      );
    }
    if (order.updated_at) {
      await RedisService.setKey(
        `${txnId}_ordrUpdtd`,
        JSON.stringify(order.updated_at),
        TTL_IN_SECONDS
      );
    }
  } catch (err: any) {
    addError(
      result,
      40000,
      `Business Error: Error storing order details: ${err.message}`
    );
  }
};

// Store billing object
const storeBilling = async (
  txnId: string,
  billing: any,
  result: ValidationError[]
): Promise<void> => {
  try {
    await RedisService.setKey(
      `${txnId}_billing`,
      JSON.stringify(billing),
      TTL_IN_SECONDS
    );
  } catch (err: any) {
    addError(
      result,
      40000,
      `Business Error: Error storing billing: ${err.message}`
    );
  }
};

// Store quote object
const storeQuote = async (
  txnId: string,
  quote: any,
  result: ValidationError[]
): Promise<void> => {
  try {
    await RedisService.setKey(
      `${txnId}_quotePrice`,
      JSON.stringify(parseFloat(quote.price.value)),
      TTL_IN_SECONDS
    );
  } catch (err: any) {
    addError(
      result,
      40000,
      `Business Error: Error storing quote: ${err.message}`
    );
  }
};

// Store payment object
const storePayment = async (
  txnId: string,
  payment: any,
  result: ValidationError[]
): Promise<void> => {
  try {
    await RedisService.setKey(
      `${txnId}_prevPayment`,
      JSON.stringify(payment),
      TTL_IN_SECONDS
    );
  } catch (err: any) {
    addError(
      result,
      40000,
      `Business Error: Error storing payment: ${err.message}`
    );
  }
};

// Validate order (id, state, timestamps)
const validateOrder = async (
  txnId: string,
  order: any,
  context: any,
  result: ValidationError[]
): Promise<void> => {
  try {
    const contextTime = new Date(context.timestamp).getTime();
    const createdTime = new Date(order.created_at).getTime();
    const updatedTime = new Date(order.updated_at).getTime();

    if (isNaN(createdTime) || createdTime !== contextTime) {
      addError(
        result,
        20009,
        `Timeout: order.created_at must match context.timestamp in /${constants.CONFIRM}`
      );
    }

    if (isNaN(updatedTime) || updatedTime !== createdTime) {
      addError(
        result,
        20009,
        `Timeout: order.updated_at must match order.created_at in /${constants.CONFIRM}`
      );
    }
  } catch (err: any) {
    addError(
      result,
      30019,
      `Order Confirm Error: Error validating order: ${err.message}`
    );
  }
};

// Validate provider details
const validateProvider = async (
  txnId: string,
  provider: any,
  result: ValidationError[]
): Promise<void> => {
  try {
    const providerId = await getRedisValue(`${txnId}_providerId`);
    if (providerId && providerId !== provider.id) {
      addError(
        result,
        30018,
        `Invalid Order: Provider Id mismatches in /${constants.ON_SEARCH} and /${constants.CONFIRM}`
      );
    }

    const providerLoc = await getRedisValue(`${txnId}_providerLoc`);
    const locationId = provider.locations?.[0]?.id;
    if (providerLoc && providerLoc !== locationId) {
      addError(
        result,
        30018,
        `Invalid Order: provider.locations[0].id mismatches in /${constants.ON_SEARCH} and /${constants.CONFIRM}`
      );
    }
  } catch (err: any) {
    addError(
      result,
      30019,
      `Order Confirm Error: Error validating provider: ${err.message}`
    );
  }
};

const validateBilling = async (
  txnId: string,
  billing: any,
  context: any,
  result: ValidationError[]
): Promise<void> => {
  try {
    const contextTime = new Date(context.timestamp).getTime();

    if (billing.created_at) {
      const billingTime = new Date(billing.created_at).getTime();
      if (isNaN(billingTime) || billingTime > contextTime) {
        addError(
          result,
          20007,
          `Invalid order state: billing.created_at should not be greater than context.timestamp in /${constants.CONFIRM}`
        );
      }
    }

    if (billing.updated_at) {
      const billingTime = new Date(billing.updated_at).getTime();
      if (isNaN(billingTime) || billingTime > contextTime) {
        addError(
          result,
          20007,
          `Invalid order state: billing.updated_at should not be greater than context.timestamp in /${constants.CONFIRM}`
        );
      }
    }

    if (
      billing.created_at &&
      billing.updated_at &&
      new Date(billing.updated_at) < new Date(billing.created_at)
    ) {
      addError(
        result,
        20007,
        `Invalid order state: billing.updated_at cannot be less than billing.created_at in /${constants.CONFIRM}`
      );
    }

    const initBilling = await getRedisValue(`${txnId}_billing`);
    if (initBilling) {
      const billingErrors = compareObjects(initBilling, billing);
      billingErrors?.forEach((error: string) => {
        addError(
          result,
          20006,
          `Invalid response: billing: ${error} when compared with /${constants.ON_INIT} billing object`
        );
      });
    }
  } catch (err: any) {
    addError(
      result,
      30019,
      `Order Confirm Error: Error validating billing: ${err.message}`
    );
  }
};

const validateItems = async (
  txnId: string,
  items: any[],
  context: any,
  result: ValidationError[]
): Promise<void> => {
  try {
    const itemFlfllmnts = await getRedisValue(`${txnId}_itemFlfllmnts`);
    const itemsIdList = await getRedisValue(`${txnId}_itemsIdList`);
    const fulfillmentIdArray = await getRedisValue(
      `${txnId}_fulfillmentIdArray`
    );
    const parentItemIdSet = await getRedisValue(`${txnId}_parentItemIdSet`);

    let itemsCountChange = false;
    const updatedItemsIdList = { ...itemsIdList };

    items.forEach((item: any, i: number) => {
      const itemId = item.id;

      if (!(itemId in itemsIdList)) {
        addError(
          result,
          30004,
          `Item not found: Item Id ${itemId} does not exist in /${constants.ON_SELECT}`
        );
      }

      if (!fulfillmentIdArray?.includes(item.fulfillment_id)) {
        addError(
          result,
          20006,
          `Invalid response: items[${i}].fulfillment_id mismatches for Item ${itemId} in /${constants.ON_SELECT} and /${constants.CONFIRM}`
        );
      }

      if (
        itemsIdList &&
        itemId in itemsIdList &&
        item.quantity.count !== itemsIdList[itemId]
      ) {
        updatedItemsIdList[itemId] = item.quantity.count;
        itemsCountChange = true;
        addError(
          result,
          20006,
          `Invalid response: items[${i}].quantity.count for item ${itemId} mismatches with /${constants.SELECT}`
        );
      }

      if (
        parentItemIdSet &&
        item.parent_item_id &&
        !parentItemIdSet.includes(item.parent_item_id)
      ) {
        addError(
          result,
          20006,
          `Invalid response: items[${i}].parent_item_id mismatches for Item ${itemId} in /${constants.ON_SEARCH} and /${constants.CONFIRM}`
        );
      }

      const typeTag = item.tags?.find((tag: any) => tag.code === "type");
      const typeValue = typeTag?.list?.find(
        (listItem: any) => listItem.code === "type"
      )?.value;
      const isItemType = typeValue === "item";
    });

    if (itemsCountChange) {
      await RedisService.setKey(
        `${txnId}_itemsIdList`,
        JSON.stringify(updatedItemsIdList),
        TTL_IN_SECONDS
      );
    }
  } catch (err: any) {
    addError(
      result,
      30019,
      `Order Confirm Error: Error validating items: ${err.message}`
    );
  }
};

const validateFulfillments = async (
  txnId: string,
  fulfillments: any[],
  result: ValidationError[]
): Promise<void> => {
  try {
    const fulfillmentIdArray = await getRedisValue(
      `${txnId}_fulfillmentIdArray`
    );
    const buyerGps = await getRedisValue(`${txnId}_buyerGps`);
    const buyerAddr = await getRedisValue(`${txnId}_buyerAddr`);
    const gpsRegex = /^-?\d{1,3}\.\d+,-?\d{1,3}\.\d+$/;

    fulfillments.forEach(async (fulfillment: any, i: number) => {
      const id = fulfillment.id;
      if (!fulfillmentIdArray?.includes(id)) {
        addError(
          result,
          20006,
          `Invalid response: fulfillment id ${id} does not exist in /${constants.ON_SELECT}`
        );
      }

      const type = fulfillment.type;
      const category = fulfillment["@ondc/org/category"];
      const vehicle = fulfillment.vehicle;
      const SELF_PICKUP = "Self-Pickup";
      const KERBSIDE = "Kerbside";

      if (type === SELF_PICKUP && category === KERBSIDE) {
        if (!vehicle) {
          addError(
            result,
            20006,
            `Invalid response: Vehicle is required for fulfillment ${i} with type ${SELF_PICKUP} and category ${KERBSIDE} in /${constants.CONFIRM}`
          );
        } else if (!vehicle.registration) {
          addError(
            result,
            20006,
            `Invalid response: Vehicle registration is required for fulfillment ${i} with type ${SELF_PICKUP} and category ${KERBSIDE} in /${constants.CONFIRM}`
          );
        }
      } else if (vehicle) {
        addError(
          result,
          20006,
          `Invalid response: Vehicle should not be present in fulfillment ${i} with type ${type} and category ${category} in /${constants.CONFIRM}`
        );
      }

      const gps = fulfillment.end?.location?.gps;
      if (!gpsRegex.test(gps)) {
        addError(
          result,
          20006,
          `Invalid response: fulfillments[${i}].end.location.gps has invalid format in /${constants.CONFIRM}`
        );
      } else if (buyerGps && !_.isEqual(gps, buyerGps)) {
        addError(
          result,
          20006,
          `Invalid response: gps coordinates in fulfillments[${i}].end.location mismatch in /${constants.ON_SELECT} & /${constants.CONFIRM}`
        );
      }

      const areaCode = fulfillment.end?.location?.address?.area_code;
      if (buyerAddr && !_.isEqual(areaCode, buyerAddr)) {
        addError(
          result,
          20006,
          `Invalid response: address.area_code in fulfillments[${i}].end.location mismatch in /${constants.ON_SELECT} & /${constants.CONFIRM}`
        );
      }

      const address = fulfillment.end?.location?.address;
      if (address) {
        const lenName = address.name?.length || 0;
        const lenBuilding = address.building?.length || 0;
        const lenLocality = address.locality?.length || 0;

        if (lenName + lenBuilding + lenLocality >= 190) {
          addError(
            result,
            20006,
            `Invalid response: address.name + address.building + address.locality should be < 190 chars in fulfillments[${i}]`
          );
        }

        if (lenBuilding <= 3) {
          addError(
            result,
            20006,
            `Invalid response: address.building should be > 3 chars in fulfillments[${i}]`
          );
        }
        if (lenName <= 3) {
          addError(
            result,
            20006,
            `Invalid response: address.name should be > 3 chars in fulfillments[${i}]`
          );
        }
        if (lenLocality <= 3) {
          addError(
            result,
            20006,
            `Invalid response: address.locality should be > 3 chars in fulfillments[${i}]`
          );
        }

        if (
          address.building === address.locality ||
          address.name === address.building ||
          address.name === address.locality
        ) {
          addError(
            result,
            20006,
            `Invalid response: address.name, address.building, and address.locality should be unique in fulfillments[${i}]`
          );
        }
      }

      const tracking = await getRedisValue(`${txnId}_${id}_tracking`);
      if (tracking != null) {
        if (tracking !== fulfillment.tracking) {
          addError(
            result,
            20006,
            `Invalid response: Fulfillment Tracking mismatch with the ${constants.ON_SELECT} call in /${constants.CONFIRM}`
          );
        }
      }
    });
  } catch (err: any) {
    addError(
      result,
      30019,
      `Order Confirm Error: Error validating fulfillments: ${err.message}`
    );
  }
};

const validateQuote = async (
  txnId: string,
  quote: any,
  context: any,
  result: ValidationError[]
): Promise<void> => {
  try {
    let breakupPrice = 0;
    quote.breakup.forEach((element: { price: { value: string } }) => {
      breakupPrice += parseFloat(element.price.value);
    });

    const quotePrice = parseFloat(quote.price.value);
    if (Math.round(quotePrice) !== Math.round(breakupPrice)) {
      addError(
        result,
        20006,
        `Invalid response: Quoted Price ${quotePrice} does not match with Net Breakup Price ${breakupPrice} in /${constants.CONFIRM}`
      );
    }

    const onSelectQuote = await getRedisValue(`${txnId}_quoteObj`);
    if (onSelectQuote) {
      const quoteErrors = compareQuoteObjects(
        onSelectQuote,
        quote,
        constants.ON_SELECT,
        constants.CONFIRM
      );
      quoteErrors?.forEach((error: string) => {
        addError(result, 20006, `Invalid response: quote: ${error}`);
      });
    }

    const initQuotePrice = await getRedisValue(`${txnId}_initQuotePrice`);
    if (
      initQuotePrice &&
      Math.round(parseFloat(initQuotePrice)) !== Math.round(quotePrice)
    ) {
      addError(
        result,
        20006,
        `Invalid response: Quoted Price in /${constants.CONFIRM} INR ${quotePrice} does not match with /${constants.ON_INIT} INR ${initQuotePrice}`
      );
    }

    if (_.some(quote.breakup, (item) => _.has(item, "item.quantity"))) {
      addError(
        result,
        20006,
        `Invalid response: Extra attribute Quantity provided in quote object after on_select in /${constants.CONFIRM}`
      );
    }
  } catch (err: any) {
    addError(
      result,
      30019,
      `Order Confirm Error: Error validating quote: ${err.message}`
    );
  }
};

const validatePayment = async (
  txnId: string,
  payment: any,
  quote: any,
  context: any,
  flow: string,
  result: ValidationError[]
): Promise<void> => {
  try {
    if (payment.type === "ON-ORDER") {
      const quotePrice = parseFloat(quote.price.value);
      if (parseFloat(payment.params.amount) !== quotePrice) {
        addError(
          result,
          20006,
          `Invalid response: Payment amount ${payment.params.amount} does not match quote price ${quotePrice} in /${constants.CONFIRM}`
        );
      }
    }
    const buyerFF = await getRedisValue(`${txnId}_buyerFFAmount`);
    if (
      buyerFF &&
      parseFloat(payment["@ondc/org/buyer_app_finder_fee_amount"]) !==
        parseFloat(buyerFF)
    ) {
      addError(
        result,
        40004,
        `Payment type not supported: Buyer app finder fee can't change in /${constants.CONFIRM}`
      );
    }

    const initSettlementDetails = await getRedisValue(`${txnId}_sttlmntdtls`);
    if (
      initSettlementDetails &&
      !_.isEqual(
        payment["@ondc/org/settlement_details"][0],
        initSettlementDetails
      )
    ) {
      addError(
        result,
        20006,
        `Invalid response: payment settlement_details mismatch in /${constants.ON_INIT} & /${constants.CONFIRM}`
      );
    }

    const settlementDetails = payment["@ondc/org/settlement_details"]?.[0];
    if (!settlementDetails) {
      addError(
        result,
        20006,
        `Invalid response: settlement_details missing in /${constants.CONFIRM}`
      );
    } else {
      if (settlementDetails.settlement_counterparty !== "seller-app") {
        addError(
          result,
          20006,
          `Invalid response: settlement_counterparty must be 'seller-app' in @ondc/org/settlement_details`
        );
      }

      const { settlement_type } = settlementDetails;
      if (!["neft", "rtgs", "upi"].includes(settlement_type)) {
        addError(
          result,
          20006,
          `Invalid response: settlement_type must be 'neft/rtgs/upi' in @ondc/org/settlement_details`
        );
      } else if (settlement_type !== "upi") {
        const missingFields = [];
        if (!settlementDetails.bank_name) missingFields.push("bank_name");
        if (!settlementDetails.branch_name) missingFields.push("branch_name");
        if (
          !settlementDetails.beneficiary_name ||
          settlementDetails.beneficiary_name.trim() === ""
        ) {
          missingFields.push("beneficiary_name");
        }
        if (!settlementDetails.settlement_phase)
          missingFields.push("settlement_phase");
        if (!settlementDetails.settlement_ifsc_code)
          missingFields.push("settlement_ifsc_code");
        if (
          !settlementDetails.settlement_bank_account_no ||
          settlementDetails.settlement_bank_account_no.trim() === ""
        ) {
          missingFields.push("settlement_bank_account_no");
        }
      }
      if (payment.collected_by === "BAP") {
        if (!payment.type || payment.type !== "ON-ORDER") {
          addError(
            result,
            20006,
            `Invalid response: payment.type must be 'ON-ORDER' when collected_by is 'BAP' in /${constants.CONFIRM}`
          );
        }
        if (!payment.status || payment.status !== "PAID") {
          addError(
            result,
            20006,
            `Invalid response: payment.status must be 'PAID' when collected_by is 'BAP' in /${constants.CONFIRM}`
          );
        }
        if (
          !payment.uri ||
          !/^https?:\/\/[^\s/$.?#].[^\s]*$/.test(payment.uri)
        ) {
          addError(
            result,
            20006,
            `Invalid response: payment.uri must be a valid URL in /${constants.CONFIRM}`
          );
        }
        if (!payment.tl_method || payment.tl_method !== "http/get") {
          addError(
            result,
            20006,
            `Invalid response: payment.tl_method must be 'http/get' when collected_by is 'BAP' in /${constants.CONFIRM}`
          );
        }
        if (payment.params) {
          if (
            !payment.params.currency ||
            !/^[A-Z]{3}$/.test(payment.params.currency)
          ) {
            addError(
              result,
              20006,
              `Invalid response: payment.params.currency must be a valid ISO 4217 code in /${constants.CONFIRM}`
            );
          }
          if (
            !payment.params.transaction_id ||
            typeof payment.params.transaction_id !== "string" ||
            payment.params.transaction_id === ""
          ) {
            addError(
              result,
              20006,
              `Invalid response: payment.params.transaction_id must be a non-empty string in /${constants.CONFIRM}`
            );
          }
        }
      } else if (payment.type === "ON-FULFILLMENT") {
        if (payment.collected_by !== "BPP" || payment.status != "NOT-PAID") {
          addError(
            result,
            20006,
            `Invalid response:  payment.collected_by must be "BPP" and payment.status must be "NOT-PAID" if payment.status is "ON-FULFILLMENT" in /${constants.CONFIRM}`
          );
        }
      }
    }
  } catch (err: any) {
    addError(
      result,
      30019,
      `Order Confirm Error: Error validating payment: ${err.message}`
    );
  }
};

const validateTags = async (
  txnId: string,
  tags: any[],
  result: ValidationError[]
): Promise<void> => {
  try {
    console.log("🚀 ~ tags:", JSON.stringify(tags, null, 2));
    if (tags?.length) {
      const bppTermsTag = tags.find((tag: any) => tag.code === "bpp_terms");
      if (bppTermsTag) {
        if (!isTagsValid(tags, "bpp_terms")) {
          addError(
            result,
            20006,
            `Invalid response: Tags should have valid gst number and fields in /${constants.CONFIRM}`
          );
        }

        const tagsList = bppTermsTag.list || [];
        const acceptBapTerms = tagsList.filter(
          (item: any) => item.code === "accept_bap_terms"
        );
        if (acceptBapTerms.length > 0) {
          addError(
            result,
            20006,
            `Invalid response: accept_bap_terms is not required in /${constants.CONFIRM}`
          );
        }

        let tax_number: any = {};
        let provider_tax_number: any = {};

        tagsList.forEach((e: any) => {
          if (e.code === "tax_number") {
            if (!e.value) {
              addError(
                result,
                20006,
                `Invalid response: value must be present for tax_number in /${constants.CONFIRM}`
              );
            } else {
              const taxNumberPattern =
                /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;
              if (!taxNumberPattern.test(e.value)) {
                addError(
                  result,
                  20006,
                  `Invalid response: Invalid format for tax_number in /${constants.CONFIRM}`
                );
              }
              if (e.value.length !== 15) {
                addError(
                  result,
                  20006,
                  `Invalid response: tax_number must be 15 digits in /${constants.CONFIRM}`
                );
              }
            }
            tax_number = e;
          }
          if (e.code === "provider_tax_number") {
            if (!e.value) {
              addError(
                result,
                20006,
                `Invalid response: value must be present for provider_tax_number in /${constants.CONFIRM}`
              );
            } else {
              const taxNumberPattern = /^[A-Z]{5}[0-9]{4}[A-Z]{1}$/;
              if (!taxNumberPattern.test(e.value)) {
                addError(
                  result,
                  20006,
                  `Invalid response: Invalid format for provider_tax_number in /${constants.CONFIRM}`
                );
              }
            }
            provider_tax_number = e;
          }
        });

        if (_.isEmpty(tax_number)) {
          addError(
            result,
            20006,
            `Invalid response: tax_number must be present in /${constants.CONFIRM}`
          );
        }
        if (_.isEmpty(provider_tax_number)) {
          addError(
            result,
            20006,
            `Invalid response: provider_tax_number must be present in /${constants.CONFIRM}`
          );
        }
        
      }

      const bapTermsTag = tags.find((tag: any) => tag.code === "bap_terms");
      console.log("🚀 ~ bapTermsTag:", JSON.stringify(bapTermsTag))
      
      if (bapTermsTag) {
        if (!isTagsValid(tags, "bap_terms")) {
          addError(
            result,
            20006,
            `Invalid response: Tags/bap_terms should have valid gst number and fields in /${constants.CONFIRM}`
          );
        }

        const hasStaticTerms = bapTermsTag.list?.some(
          (item: any) => item.code === "static_terms"
        );
        if (hasStaticTerms) {
          addError(
            result,
            20006,
            `Invalid response: static_terms is not required in /${constants.CONFIRM}`
          );
        }

        const bapTaxNumber = bapTermsTag.list?.find(
          (item: any) => item.code === "tax_number"
        )?.value;
        const bppTaxNumber = bppTermsTag?.list?.find(
          (item: any) => item.code === "tax_number"
        )?.value;
        if (
          bapTaxNumber &&
          bppTaxNumber &&
          _.isEqual(bapTaxNumber, bppTaxNumber)
        ) {
          addError(
            result,
            20006,
            `Invalid response: Tags/bap_terms and Tags/bpp_terms should have different gst numbers in /${constants.CONFIRM}`
          );
        }
      }

      const onInitTags = await getRedisValue(`${txnId}_on_init_tags`);
      console.log(
      JSON.stringify(onInitTags, null, 2)
    )
      if (onInitTags && bppTermsTag) {
        const initBppTerms = onInitTags.find(
          (tag: any) => tag.code === "bpp_terms"
        );
        if (initBppTerms && !_.isEqual(bppTermsTag, initBppTerms)) {
          addError(
            result,
            20006,
            `Invalid response: Tags/bpp_terms should match /${constants.ON_INIT} in /${constants.CONFIRM}`
          );
        }
      }

      await RedisService.setKey(
        `${txnId}_confirm_tags`,
        JSON.stringify(tags),
        TTL_IN_SECONDS
      );
      if (bppTermsTag) {
        await RedisService.setKey(
          `${txnId}_list_CONFIRM`,
          JSON.stringify(bppTermsTag.list),
          TTL_IN_SECONDS
        );
      }
    }
  } catch (err: any) {

    addError(
      result,
      30019,
      `Order Confirm Error: Error validating tags: ${err.message}`
    );
  }
};

// Main confirm function
export const confirm = async (data: any) => {
  const { context, message } = data;
  const result: ValidationError[] = [];
  const txnId = context?.transaction_id;
  const flow = "2";

  try {
    await contextChecker(context, result, constants.CONFIRM, constants.ON_INIT);
  } catch (err: any) {
    addError(
      result,
      20006,
      `Invalid response: Error checking context: ${err.message}`
    );
    return result;
  }

  try {
    const order = message.order;

    await RedisService.setKey(
      `${txnId}_${ApiSequence.CONFIRM}`,
      JSON.stringify(data),
      TTL_IN_SECONDS
    );

    await validateOrder(txnId, order, context, result);
    await validateProvider(txnId, order.provider, result);
    await validateItems(txnId, order.items, context, result);
    await validateFulfillments(txnId, order.fulfillments, result);
    await validateBilling(txnId, order.billing, context, result);
    await validateQuote(txnId, order.quote, context, result);
    await validatePayment(
      txnId,
      order.payment,
      order.quote,
      context,
      flow,
      result
    );
    await validateTags(txnId, order.tags, result);

    await storeOrder(txnId, order, result);
    await storeBilling(txnId, order.billing, result);
    await storeQuote(txnId, order.quote, result);
    await storePayment(txnId, order.payment, result);

    return result;
  } catch (err: any) {
    console.error(
      `Error occurred while checking /${constants.CONFIRM} API, ${err.stack}`
    );
    addError(result, 50000, `Policy Error: Unexpected error: ${err.message}`);
    return result;
  }
};
