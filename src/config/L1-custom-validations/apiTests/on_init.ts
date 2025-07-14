import { RedisService } from "ondc-automation-cache-lib";
import { contextChecker } from "./../utils/contextUtils";
import {
  compareObjects,
  compareQuoteObjects,
  getRedisValue,
  isTagsValid,
  payment_status,
} from "./../utils/helper";
import constants, { ApiSequence } from "./../utils/constants";
import _ from "lodash";

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
      20006,
      `Invalid response: Error storing billing: ${err.message}`
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
      `${txnId}_initQuote`,
      JSON.stringify(quote),
      TTL_IN_SECONDS
    );
  } catch (err: any) {
    addError(
      result,
      20006,
      `Invalid response: Error storing quote: ${err.message}`
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
      `${txnId}_payment`,
      JSON.stringify(payment),
      TTL_IN_SECONDS
    );
  } catch (err: any) {
    addError(
      result,
      20006,
      `Invalid response: Error storing payment: ${err.message}`
    );
  }
};

// Store applicable offers
const storeApplicableOffers = async (
  txnId: string,
  offers: any[],
  result: ValidationError[]
): Promise<void> => {
  try {
    await RedisService.setKey(
      `${txnId}_${ApiSequence.ON_INIT}_offers`,
      JSON.stringify(offers),
      TTL_IN_SECONDS
    );
  } catch (err: any) {
    addError(
      result,
      20006,
      `Invalid response: Error storing applicable offers: ${err.message}`
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
        20006,
        `Invalid response: Provider Id mismatches in /${constants.ON_SEARCH} and /${constants.ON_INIT}`
      );
    }

    const providerLoc = await getRedisValue(`${txnId}_providerLoc`);
    const locationId = provider.locations?.[0]?.id;
    if (providerLoc && providerLoc !== locationId) {
      addError(
        result,
        20006,
        `Invalid response: provider.locations[0].id mismatches in /${constants.ON_SEARCH} and /${constants.ON_INIT}`
      );
    }
  } catch (err: any) {
    addError(
      result,
      20006,
      `Invalid response: Error validating provider: ${err.message}`
    );
  }
};

// Validate billing timestamps and comparison
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
          `Invalid order state: billing.created_at should not be greater than context.timestamp in /${constants.ON_INIT}`
        );
      }
    }

    if (billing.updated_at) {
      const billingTime = new Date(billing.updated_at).getTime();
      if (isNaN(billingTime) || billingTime > contextTime) {
        addError(
          result,
          20007,
          `Invalid order state: billing.updated_at should not be greater than context.timestamp in /${constants.ON_INIT}`
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
        `Invalid order state: billing.updated_at cannot be less than billing.created_at in /${constants.ON_INIT}`
      );
    }

    const selectBilling = await getRedisValue(`${txnId}_billing_select`);
    if (selectBilling) {
      const billingErrors = compareObjects(selectBilling, billing);
      billingErrors?.forEach((error: string) => {
        addError(
          result,
          20006,
          `Invalid response: billing: ${error} when compared with /${constants.ON_SELECT} billing object`
        );
      });
    }
  } catch (err: any) {
    addError(
      result,
      20006,
      `Invalid response: Error validating billing: ${err.message}`
    );
  }
};

// Validate items (IDs, quantities, parent_item_id, location_id)
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
    const onSearchItems = await getRedisValue(`${txnId}_onSearchItems`);

    items.forEach((item: any, i: number) => {
      const itemId = item.id;

      // Validate item ID existence
      if (!(itemId in itemsIdList)) {
        addError(
          result,
          30004,
          `Item not found: Item Id ${itemId} does not exist in /${constants.ON_SELECT}`
        );
      }

      // Validate fulfillment ID
      if (!fulfillmentIdArray?.includes(item.fulfillment_id)) {
        addError(
          result,
          20006,
          `Invalid response: items[${i}].fulfillment_id mismatches for Item ${itemId} in /${constants.ON_SELECT} and /${constants.ON_INIT}`
        );
      }

      // Validate quantity
      if (
        itemsIdList &&
        itemId in itemsIdList &&
        item.quantity.count !== itemsIdList[itemId]
      ) {
        addError(
          result,
          20006,
          `Invalid response: items[${i}].quantity.count for item ${itemId} mismatches with /${constants.SELECT}`
        );
      }

      // Validate parent_item_id
      if (
        parentItemIdSet &&
        item.parent_item_id &&
        !parentItemIdSet.includes(item.parent_item_id)
      ) {
        addError(
          result,
          20006,
          `Invalid response: items[${i}].parent_item_id mismatches for Item ${itemId} in /${constants.ON_SEARCH} and /${constants.ON_INIT}`
        );
      }

      // Validate type and parent_item_id
      const typeTag = item.tags?.find((tag: any) => tag.code === "type");
      const typeValue = typeTag?.list?.find(
        (listItem: any) => listItem.code === "type"
      )?.value;
      const isItemType = typeValue === "item";

      // Validate Buyer-Delivery tags
      const fulfillment = (context.fulfillments || []).find(
        (f: any) => f.id === item.fulfillment_id
      );
      if (fulfillment?.type === "Buyer-Delivery") {
        const rtoTag = item.tags?.find((tag: any) => tag.code === "rto_action");

        const returnToOrigin = rtoTag.list?.find(
          (i: any) => i.code === "return_to_origin"
        );
        if (!returnToOrigin || returnToOrigin.value?.toLowerCase() !== "yes") {
          addError(
            result,
            20006,
            `Invalid response: 'return_to_origin' must be 'yes' in 'rto_action' tag of items[${i}]`
          );
        }
      }
    });
  } catch (err: any) {
    addError(
      result,
      20006,
      `Invalid response: Error validating items: ${err.message}`
    );
  }
};

// Validate fulfillments (IDs, GPS, area_code, Buyer-Delivery)
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

    fulfillments.forEach(async (fulfillment: any, i: number) => {
      const id = fulfillment.id;
      if (!fulfillmentIdArray?.includes(id)) {
        addError(
          result,
          20006,
          `Invalid response: fulfillment id ${id} does not exist in /${constants.ON_SELECT}`
        );
      }

      if (fulfillment.type !== "Delivery") {
        addError(
          result,
          20006,
          `Invalid response: Fulfillment type should be 'Delivery' (case-sensitive)`
        );
      } else if (
        fulfillment.tags?.length > 0 &&
        fulfillment.type !== "Buyer-Delivery"
      ) {
        addError(
          result,
          20006,
          `Invalid response: /message/order/fulfillment of type 'Delivery' should not have tags`
        );
      }

      const gps = fulfillment.end?.location?.gps;
      if (buyerGps && !_.isEqual(gps, buyerGps)) {
        console.log(`buyerGps: ${buyerGps}, gps: ${gps}`);
        addError(
          result,
          20006,
          `Invalid response: gps coordinates in fulfillments[${i}].end.location mismatch in /${constants.ON_SELECT} & /${constants.ON_INIT}`
        );
      }

      const areaCode = fulfillment.end?.location?.address?.area_code;
      if (buyerAddr && !_.isEqual(areaCode, buyerAddr)) {
        addError(
          result,
          20006,
          `Invalid response: address.area_code in fulfillments[${i}].end.location mismatch in /${constants.ON_SELECT} & /${constants.ON_INIT}`
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
            `Invalid response: address.name + address.building + address.locality should be < 190 chars`
          );
        }

        if (lenBuilding <= 3) {
          addError(
            result,
            20006,
            `Invalid response: address.building should be > 3 chars`
          );
        }
        if (lenName <= 3) {
          addError(
            result,
            20006,
            `Invalid response: address.name should be > 3 chars`
          );
        }
        if (lenLocality <= 3) {
          addError(
            result,
            20006,
            `Invalid response: address.locality should be > 3 chars`
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
            `Invalid response: address.name, address.building, and address.locality should be unique`
          );
        }
      }

      if (fulfillment.type === "Buyer-Delivery") {
        const orderDetailsTag = fulfillment.tags?.find(
          (tag: any) => tag.code === "order_details"
        );

        const requiredFields = [
          "weight_unit",
          "weight_value",
          "dim_unit",
          "length",
          "breadth",
          "height",
        ];
        orderDetailsTag.list?.forEach((item: any) => {
          if (
            requiredFields.includes(item.code) &&
            (!item.value || item.value.toString().trim() === "")
          ) {
            addError(
              result,
              20006,
              `Invalid response: '${item.code}' is missing or empty in 'order_details' tag in fulfillments`
            );
          }
        });

        const rtoTag = fulfillment.tags?.find(
          (tag: any) => tag.code === "rto_action"
        );

        const returnToOrigin = rtoTag.list?.find(
          (i: any) => i.code === "return_to_origin"
        );
        if (!returnToOrigin || returnToOrigin.value?.toLowerCase() !== "yes") {
          addError(
            result,
            20006,
            `Invalid response: 'return_to_origin' must be 'yes' in 'rto_action' tag in fulfillments`
          );
        }
      }

      const tracking = await getRedisValue(`${txnId}_${id}_tracking`);
      if (tracking != null) {
        if (tracking !== fulfillment.tracking) {
          addError(
            result,
            20006,
            `Invalid response: Fulfillment Tracking mismatch with the ${constants.ON_SELECT} call`
          );
        }
      }
    });
  } catch (err: any) {
    addError(
      result,
      20006,
      `Invalid response: Error validating fulfillments: ${err.message}`
    );
  }
};

// Validate quote
const validateQuote = async (
  txnId: string,
  quote: any,
  context: any,
  result: ValidationError[]
): Promise<void> => {
  try {
    let initBreakupPrice = 0;
    quote.breakup.forEach((element: { price: { value: string } }) => {
      initBreakupPrice += parseFloat(element.price.value);
    });

    const initQuotePrice = parseFloat(quote.price.value);
    if (Math.round(initQuotePrice) !== Math.round(initBreakupPrice)) {
      addError(
        result,
        20006,
        `Invalid response: Quoted Price ${initQuotePrice} does not match with Net Breakup Price ${initBreakupPrice} in /${constants.ON_INIT}`
      );
    }

    const onSelectQuote = await getRedisValue(`${txnId}_quoteObj`);
    if (onSelectQuote) {
      const quoteErrors = compareQuoteObjects(
        onSelectQuote,
        quote,
        constants.ON_SELECT,
        constants.ON_INIT
      );
      quoteErrors?.forEach((error: string) => {
        addError(result, 20006, `Invalid response: quote: ${error}`);
      });
    }

    const onSelectPrice = await getRedisValue(`${txnId}_onSelectPrice`);
    if (
      onSelectPrice &&
      Math.round(parseFloat(onSelectPrice)) !== Math.round(initQuotePrice)
    ) {
      addError(
        result,
        20006,
        `Invalid response: Quoted Price in /${constants.ON_INIT} INR ${initQuotePrice} does not match with /${constants.ON_SELECT} INR ${onSelectPrice}`
      );
    }

    if (_.some(quote.breakup, (item) => _.has(item, "item.quantity"))) {
      addError(
        result,
        20006,
        `Invalid response: Extra attribute Quantity provided in quote object after on_select`
      );
    }
  } catch (err: any) {
    addError(
      result,
      20006,
      `Invalid response: Error validating quote: ${err.message}`
    );
  }
};

// Validate payment
const validatePayment = async (
  txnId: string,
  payment: any,
  context: any,
  flow: string,
  result: ValidationError[]
): Promise<void> => {
  try {
    if (!payment) {
      addError(
        result,
        20006,
        `Invalid response: Payment Object can't be null in /${constants.ON_INIT}`
      );
      return;
    }

    const buyerFF = await getRedisValue(
      `${txnId}_${ApiSequence.SEARCH}_buyerFF`
    );
    if (
      buyerFF &&
      parseFloat(payment["@ondc/org/buyer_app_finder_fee_amount"]) !==
        parseFloat(buyerFF)
    ) {
      addError(
        result,
        41001,
        `Finder fee not acceptable: The buyer app finder fee is not acceptable`
      );
    }

    const validSettlementBasis = ["delivery", "shipment"];
    const settlementBasis = payment["@ondc/org/settlement_basis"];
    if (settlementBasis && !validSettlementBasis.includes(settlementBasis)) {
      addError(
        result,
        20006,
        `Invalid response: Invalid settlement basis in /${
          constants.ON_INIT
        }. Expected: ${validSettlementBasis.join(", ")}`
      );
    }

    const settlementWindow = payment["@ondc/org/settlement_window"];
    if (
      settlementWindow &&
      !/^P(?=\d|T\d)(\d+Y)?(\d+M)?(\d+D)?(T(?=\d)(\d+H)?(\d+M)?(\d+(\.\d+)?S)?)?$/.test(
        settlementWindow
      )
    ) {
      addError(
        result,
        20006,
        `Invalid response: Invalid settlement window in /${constants.ON_INIT}. Expected format: PTd+[MH]`
      );
    }

    const settlementDetails = payment["@ondc/org/settlement_details"]?.[0];
    if (!settlementDetails) {
      addError(
        result,
        20006,
        `Invalid response: settlement_details missing in /${constants.ON_INIT}`
      );
    } else {
      await RedisService.setKey(
        `${txnId}_sttlmntdtls`,
        JSON.stringify(settlementDetails)
      );
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
        if (!settlementDetails.settlement_counterparty)
          missingFields.push("settlement_counterparty");
        if (
          !settlementDetails.settlement_bank_account_no ||
          settlementDetails.settlement_bank_account_no.trim() === ""
        ) {
          missingFields.push("settlement_bank_account_no");
        }
        if (missingFields.length > 0) {
          addError(
            result,
            20006,
            `Invalid response: Payment details missing: ${missingFields.join(
              ", "
            )}`
          );
        }
      } else if (
        !settlementDetails.upi_address ||
        settlementDetails.upi_address.trim() === ""
      ) {
        addError(
          result,
          20006,
          `Invalid response: Payment details missing: upi_address`
        );
      }
    }

    if (payment.collected_by === "BPP" && payment.type !== "ON-FULFILLMENT") {
      if (!payment.type || payment.type !== "ON-ORDER") {
        addError(
          result,
          20006,
          `Invalid response: Type must be 'ON-ORDER' in payment`
        );
      }
      if (!payment.uri || !/^https?:\/\/[^\s/$.?#].[^\s]*$/.test(payment.uri)) {
        addError(
          result,
          20006,
          `Invalid response: Uri must be a valid URL in payment`
        );
      }
      if (!payment.status || payment.status !== "NOT-PAID") {
        addError(
          result,
          20006,
          `Invalid response: Status must be 'NOT-PAID' in payment`
        );
      }
      if (
        !payment.params ||
        typeof payment.params !== "object" ||
        payment.params === null
      ) {
        addError(
          result,
          20006,
          `Invalid response: Params must be a non-null object in payment`
        );
      }
      if (
        !payment["@ondc/org/settlement_basis"] ||
        payment["@ondc/org/settlement_basis"] !== "delivery"
      ) {
        addError(
          result,
          20006,
          `Invalid response: Settlement_basis must be 'delivery' in payment`
        );
      }
      if (
        !payment["@ondc/org/settlement_window"] ||
        !/^P(\d+D)?$/.test(payment["@ondc/org/settlement_window"])
      ) {
        addError(
          result,
          20006,
          `Invalid response: Settlement_window must be a valid ISO 8601 duration in payment`
        );
      }
      if (
        !payment.tags ||
        !Array.isArray(payment.tags) ||
        payment.tags.length === 0
      ) {
        addError(
          result,
          20006,
          `Invalid response: Tags must be a non-empty array in payment`
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
            `Invalid response: Currency must be a valid ISO 4217 code in params`
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
            `Invalid response: Transaction_id must be a non-empty string in params`
          );
        }
        if (
          !payment.params.amount ||
          !/^\d*\.\d{2}$/.test(payment.params.amount)
        ) {
          addError(
            result,
            20006,
            `Invalid response: Amount must be a valid decimal number in params`
          );
        }
      }

      payment.tags?.forEach((tag: any, index: number) => {
        if (!tag.code || tag.code !== "bpp_collect") {
          addError(
            result,
            20006,
            `Invalid response: payment.tag[${index}].code must be 'bpp_collect'`
          );
        }
        if (!tag.list || !Array.isArray(tag.list) || tag.list.length === 0) {
          addError(
            result,
            20006,
            `Invalid response: payment.tag[${index}].list must be a non-empty array`
          );
        }
        const codes = new Set();
        tag.list?.forEach((item: any, itemIndex: number) => {
          if (!item.code || !["success", "error"].includes(item.code)) {
            addError(
              result,
              20006,
              `Invalid response: payment.tag[${index}].list[${itemIndex}].code must be 'success' or 'error'`
            );
          }
          if (item.code && codes.has(item.code)) {
            addError(
              result,
              20006,
              `Invalid response: payment.tag[${index}].list[${itemIndex}].code is a duplicate`
            );
          } else if (item.code) {
            codes.add(item.code);
          }
          if (!item.value || typeof item.value !== "string") {
            addError(
              result,
              20006,
              `Invalid response: payment.tag[${index}].list[${itemIndex}].value must be a string`
            );
          } else if (item.code === "success" && item.value !== "Y") {
            addError(
              result,
              20006,
              `Invalid response: payment.tag[${index}].list[${itemIndex}].value must be 'Y' for code 'success'`
            );
          } else if (
            item.code === "error" &&
            (item.value === "" || item.value === "..")
          ) {
            addError(
              result,
              20006,
              `Invalid response: payment.tag[${index}].list[${itemIndex}].value is invalid for code 'error'`
            );
          }
        });
      });
    }

    const status = payment_status(payment, flow);
    if (!status || status.message) {
      addError(
        result,
        20006,
        `Invalid response: ${
          status.message || `Transaction_id missing in message/order/payment`
        }`
      );
    }
  } catch (err: any) {
    addError(
      result,
      20006,
      `Invalid response: Error validating payment: ${err.message}`
    );
  }
};

// Validate tags (tax numbers, bpp_terms)
const validateTags = async (
  txnId: string,
  tags: any[],
  result: ValidationError[]
): Promise<void> => {
  try {
    if (tags?.length) {
      if (!isTagsValid(tags, "bpp_terms")) {
        addError(
          result,
          20006,
          `Invalid response: Tags should have valid gst number and fields in /${constants.ON_INIT}`
        );
      }

      const bppTermsTag = tags.find((tag: any) => tag.code === "bpp_terms");
      if (bppTermsTag) {
        const tagsList = bppTermsTag.list || [];
        const acceptBapTerms = tagsList.filter(
          (item: any) => item.code === "accept_bap_terms"
        );
        if (acceptBapTerms.length > 0) {
          addError(
            result,
            20006,
            `Invalid response: accept_bap_terms is not required`
          );
        }

        let tax_number: any = {};
        let provider_tax_number: any = {};
        const np_type_on_search = await getRedisValue(
          `${txnId}_${ApiSequence.ON_SEARCH}np_type`
        );

        tagsList.forEach((e: any) => {
          if (e.code === "tax_number") {
            if (!e.value) {
              addError(
                result,
                20006,
                `Invalid response: value must be present for tax_number in ${constants.ON_INIT}`
              );
            } else {
              const taxNumberPattern =
                /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;
              if (!taxNumberPattern.test(e.value)) {
                addError(
                  result,
                  20006,
                  `Invalid response: Invalid format for tax_number in ${constants.ON_INIT}`
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
                `Invalid response: value must be present for provider_tax_number in ${constants.ON_INIT}`
              );
            } else {
              const taxNumberPattern = /^[A-Z]{5}[0-9]{4}[A-Z]{1}$/;
              if (!taxNumberPattern.test(e.value)) {
                addError(
                  result,
                  20006,
                  `Invalid response: Invalid format for provider_tax_number in ${constants.ON_INIT}`
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
            `Invalid response: tax_number must be present in ${constants.ON_INIT}`
          );
        }
        if (_.isEmpty(provider_tax_number)) {
          addError(
            result,
            20006,
            `Invalid response: provider_tax_number must be present in ${constants.ON_INIT}`
          );
        }

        if (
          tax_number.value?.length === 15 &&
          provider_tax_number?.value?.length === 10 &&
          np_type_on_search
        ) {
          const pan_id = tax_number.value.slice(2, 12);
          if (
            pan_id !== provider_tax_number.value &&
            np_type_on_search === "ISN"
          ) {
            addError(
              result,
              20006,
              `Invalid response: Pan_id is different in tax_number and provider_tax_number`
            );
          } else if (
            pan_id === provider_tax_number.value &&
            np_type_on_search === "MSN"
          ) {
            addError(
              result,
              20006,
              `Invalid response: Pan_id shouldn't be same in tax_number and provider_tax_number`
            );
          }
        }

        tags.forEach((tag: any) => {
          if (tag.code === "bap_terms") {
            const hasStaticTerms = tag.list?.some(
              (item: any) => item.code === "static_terms"
            );
            if (hasStaticTerms) {
              addError(
                result,
                20006,
                `Invalid response: static_terms is not required in ${constants.ON_INIT}`
              );
            }
          }
          const providerTaxNumber = tag.list?.find(
            (item: any) => item.code === "provider_tax_number"
          );
          if (providerTaxNumber) {
            const panRegex = /^[A-Z]{5}[0-9]{4}[A-Z]{1}$/;
            if (!panRegex.test(providerTaxNumber.value)) {
              addError(
                result,
                20006,
                `Invalid response: 'provider_tax_number' should have a valid PAN number format`
              );
            }
          }
        });
      }

      await RedisService.setKey(
        `${txnId}_bpp_tags`,
        JSON.stringify(tags),
        TTL_IN_SECONDS
      );
      await RedisService.setKey(
        `${txnId}_on_init_tags`,
        JSON.stringify(tags),
        TTL_IN_SECONDS
      );
      if (bppTermsTag) {
        await RedisService.setKey(
          `${txnId}_list_ON_INIT`,
          JSON.stringify(bppTermsTag.list),
          TTL_IN_SECONDS
        );
      }
    }
  } catch (err: any) {
    addError(
      result,
      20006,
      `Invalid response: Error validating tags: ${err.message}`
    );
  }
};

export const onInit = async (data: any) => {
  const { context, message } = data;
  const result: ValidationError[] = [];
  const txnId = context?.transaction_id;
  const flow = "2";

  try {
    await contextChecker(context, result, constants.ON_INIT, constants.INIT);
  } catch (err: any) {
    addError(result, 20006, err.message);
    return result;
  }

  try {
    const order = message.order;

    await RedisService.setKey(
      `${txnId}_${ApiSequence.ON_INIT}`,
      JSON.stringify(data),
      TTL_IN_SECONDS
    );

    await validateProvider(txnId, order.provider, result);
    await validateItems(txnId, order.items, context, result);
    await validateFulfillments(txnId, order.fulfillments, result);
    await validateBilling(txnId, order.billing, context, result);
    await validateQuote(txnId, order.quote, context, result);
    await validatePayment(txnId, order.payment, context, flow, result);
    await validateTags(txnId, order.tags, result);

    await storeBilling(txnId, order.billing, result);
    await storeQuote(txnId, order.quote, result);
    await storePayment(txnId, order.payment, result);

    return result;
  } catch (err: any) {
    console.error(
      `Error occurred while checking /${constants.ON_INIT} API, ${err.stack}`
    );
    return result;
  }
};
