import { RedisService } from "ondc-automation-cache-lib";
import constants, { ApiSequence, ffCategory } from "../utils/constants";
import { contextChecker } from "../utils/contextUtils";
import { setRedisValue, isoDurToSec, taxNotInlcusive } from "../utils/helper";
import _ from "lodash";

interface ValidationError {
  valid: boolean;
  code: number;
  description: string;
}

const retailPymntTtl: { [key: string]: string } = {
  "delivery charges": "delivery",
  "packing charges": "packing",
  tax: "tax",
  discount: "discount",
  "convenience fee": "misc",
  offer: "offer",
};

const TTL_IN_SECONDS: number = Number(process.env.TTL_IN_SECONDS) || 3600;

const addError = (result: ValidationError[], code: number, description: string) => {
  result.push({ valid: false, code, description });
};

async function validateProvider(
  onSelect: any,
  transaction_id: string,
  result: ValidationError[]
) {
  try {
    console.info(`Checking provider in /${constants.ON_SELECT}`);
    const providerIdRaw = await RedisService.getKey(`${transaction_id}_providerId`);
    const providerId = providerIdRaw ? JSON.parse(providerIdRaw) : null;
    const providerLocRaw = await RedisService.getKey(`${transaction_id}_providerLoc`);
    const providerLoc = providerLocRaw ? JSON.parse(providerLocRaw) : null;

    if (providerId != onSelect.provider.id) {
      addError(result, 20006, `provider.id mismatches in /${constants.SELECT} and /${constants.ON_SELECT}`);
    }

    if (onSelect.provider.locations[0].id !== providerLoc) {
      addError(result, 20006, `provider.locations[0].id mismatches in /${constants.SELECT} and /${constants.ON_SELECT}`);
    }
  } catch (error: any) {
    console.error(`Error while checking provider in /${constants.ON_SELECT}, ${error.stack}`);
    addError(result, 23001, `Internal Error: ${error.message}`);
  }
}

async function validateItems(
  onSelect: any,
  transaction_id: string,
  result: ValidationError[],
) {
  const itemFlfllmnts: { [key: string]: string } = {};

  try {
    console.info(`Checking item IDs in /${constants.ON_SELECT}`);
    const itemsOnSelectRaw = await RedisService.getKey(`${transaction_id}_SelectItemList`);
    const itemsOnSelect = itemsOnSelectRaw ? JSON.parse(itemsOnSelectRaw) : null;
    const selectItems: string[] = [];

    onSelect.items.forEach((item: any, index: number) => {
      if (!itemsOnSelect?.includes(item.id)) {
        addError(result, 20006, `Invalid Item Id provided in /${constants.ON_SELECT}: ${item.id}`);
      } else {
        selectItems.push(item.id);
      }

      const found = onSelect.fulfillments.some((f: any) => f.id === item.fulfillment_id);
      if (!found) {
        addError(result, 20006, `fulfillment_id for item ${item.id} does not exist in order.fulfillments[]`);
      }

      itemFlfllmnts[item.id] = item.fulfillment_id;
    });

    await Promise.all([
      setRedisValue(`${transaction_id}_SelectItemList`, selectItems, TTL_IN_SECONDS),
      RedisService.setKey(`${transaction_id}_itemFlfllmnts`, JSON.stringify(itemFlfllmnts), TTL_IN_SECONDS)
    ]);
  } catch (error: any) {
    console.error(`Error while checking items in /${constants.ON_SELECT}, ${error.stack}`);
    addError(result, 23001, `Internal Error: ${error.message}`);
  }
}

async function validateFulfillments(
  onSelect: any,
  transaction_id: string,
  result: ValidationError[],
  timestamp: any
) {
  const fulfillmentIdArray: string[] = [];
  const fulfillment_tat_obj: { [key: string]: number } = {};
  let nonServiceableFlag = 0;

  try {
    console.info(`Checking fulfillments in /${constants.ON_SELECT}`);
    const ttsRaw = await RedisService.getKey(`${transaction_id}_timeToShip`);
    const tts = ttsRaw ? JSON.parse(ttsRaw) : null;

    onSelect.fulfillments.forEach((ff: any, index: number) => {
      if (!ff.id) {
        addError(result, 20006, `Fulfillment Id must be present in /${constants.ON_SELECT}`);
        return;
      }
      fulfillmentIdArray.push(ff.id);

      if (!ff["@ondc/org/TAT"]) {
        addError(result, 20006, `Fulfillment TAT must be present for fulfillment ID: ${ff.id}`);
      } else {
        const tat = isoDurToSec(ff["@ondc/org/TAT"]);
        fulfillment_tat_obj[ff.id] = tat;
        if (tat <= tts) {
          addError(result,
            22504,
            `/fulfillments[${index}]/@ondc/org/TAT (O2D) in /${constants.ON_SELECT} can't be less than or equal to @ondc/org/time_to_ship (O2S) in /${constants.ON_SEARCH}`
          );
        }
      }

      if (!ff.state || !ff.state.descriptor?.code) {
        addError(result, 20007, `In Fulfillment${index}, descriptor code is mandatory in /${constants.ON_SELECT}`);
      } else {
        const code = ff.state.descriptor.code;
        if (code === "Non-serviceable") {
          nonServiceableFlag = 1;
        }
        if (!["Serviceable", "Non-serviceable"].includes(code)) {
          addError(result,
            20007,
            `Pre-order fulfillment state codes should be 'Serviceable' or 'Non-serviceable' in fulfillments[${index}].state.descriptor.code`
          );
        }
      }

      if (ff.state?.descriptor?.code === "Serviceable" && ff.type === "Delivery") {
        if (!ff["@ondc/org/category"] || !ffCategory[0].includes(ff["@ondc/org/category"])) {
          addError(result,
            20006,
            `In Fulfillment${index}, @ondc/org/category is not a valid value in /${constants.ON_SELECT} and should have one of these values [${ffCategory[0]}]`
          );
        }
      } else if (ff.type === "Self-Pickup") {
        if (!ff["@ondc/org/category"] || !ffCategory[1].includes(ff["@ondc/org/category"])) {
          addError(result,
            20006,
            `In Fulfillment${index}, @ondc/org/category is not a valid value in /${constants.ON_SELECT} and should have one of these values [${ffCategory[1]}]`
          );
        }
      }

      if (["Delivery", "Self-Pickup"].includes(ff.type)) {
        const timeRange = ff.type === "Delivery" ? ff.end?.time?.range : ff.start?.time?.range;
        const start = timeRange?.start ? new Date(timeRange.start) : null;
        const end = timeRange?.end ? new Date(timeRange.end) : null;
        const contextTime = new Date(timestamp);

        if (start && end && start >= end) {
          addError(result, 20008, `Start time must be less than end time in ${ff.type} fulfillment`);
        }
        if (start && start <= contextTime) {
          addError(result, 20009, `Start time must be after context.timestamp in ${ff.type} fulfillment`);
        }
      }

      if (ff.type === "Buyer-Delivery") {
        const orderDetailsTag = ff.tags?.find((tag: any) => tag.code === "order_details");
        if (!orderDetailsTag) {
          addError(result, 20008, `Missing 'order_details' tag in fulfillments when fulfillment.type is 'Buyer-Delivery'`);
        } else {
          const requiredFields = ["weight_unit", "weight_value", "dim_unit", "length", "breadth", "height"];
          const list = orderDetailsTag.list || [];
          for (const field of requiredFields) {
            const item = list.find((i: any) => i.code === field);
            if (!item || !item.value || item.value.toString().trim() === "") {
              addError(result, 20008, `'${field}' is missing or empty in 'order_details' tag in fulfillments`);
            }
          }
        }
      }

      if (ff.tracking === undefined || typeof ff.tracking !== "boolean") {
        addError(result, 20006, `Tracking must be present for fulfillment ID: ${ff.id} in boolean form`);
      } else {
        setRedisValue(`${transaction_id}_${ff.id}_tracking`, ff.tracking, TTL_IN_SECONDS);
      }

      if (ff.id === onSelect.provider.id) {
        addError(result, 20006, `Fulfillment ID can't be equal to Provider ID in /${constants.ON_SELECT}`);
      }
    });

    if (nonServiceableFlag && (!onSelect.error || onSelect.error.type !== "DOMAIN-ERROR" || onSelect.error.code !== "30009")) {
      addError(result, 20007, `Non Serviceable Domain error should be provided when fulfillment is not serviceable`);
    }

    await Promise.all([
      setRedisValue(`${transaction_id}_fulfillmentIdArray`, fulfillmentIdArray, TTL_IN_SECONDS),
      setRedisValue(`${transaction_id}_fulfillment_tat_obj`, fulfillment_tat_obj, TTL_IN_SECONDS),
    ]);
  } catch (error: any) {
    console.error(`Error while checking fulfillments in /${constants.ON_SELECT}, ${error.stack}`);
    addError(result, 23001, `Internal Error: ${error.message}`);
  }

  return { nonServiceableFlag };
}

async function validateQuote(
  onSelect: any,
  transaction_id: string,
  result: ValidationError[],
  nonServiceableFlag: number
) {
  try {
    console.info(`Checking quote in /${constants.ON_SELECT}`);

    const itemsIdListRaw = await RedisService.getKey(`${transaction_id}_itemsIdList`);
    const itemsIdList = itemsIdListRaw ? JSON.parse(itemsIdListRaw) : null;
    const itemsCtgrsRaw = await RedisService.getKey(`${transaction_id}_itemsCtgrs`);
    const itemsCtgrs = itemsCtgrsRaw ? JSON.parse(itemsCtgrsRaw) : null;
    const selectedPriceRaw = await RedisService.getKey(`${transaction_id}_selectedPrice`);
    const selectedPrice = selectedPriceRaw ? JSON.parse(selectedPriceRaw) : null;

    let onSelectPrice = 0;
    let onSelectItemsPrice = 0;
    const itemPrices = new Map<string, number>();
    const fulfillmentIdArrayRaw = await RedisService.getKey(`${transaction_id}_fulfillmentIdArray`);
    const fulfillmentIdArray = fulfillmentIdArrayRaw ? JSON.parse(fulfillmentIdArrayRaw) : [];
    let itemFlfllmntsRaw = await RedisService.getKey(`${transaction_id}_itemFlfllmnts`);
    let itemFlfllmnts: any = itemFlfllmntsRaw ? JSON.parse(itemFlfllmntsRaw) : null;

    const deliveryItems = onSelect.quote.breakup.filter(
      (item: any) => item["@ondc/org/title_type"] === "delivery"
    );
    const noOfDeliveries = deliveryItems.length;

    if (noOfDeliveries && nonServiceableFlag) {
      deliveryItems.forEach((e: any) => {
        if (parseFloat(e.price.value) > 0) {
          addError(result, 22506, `Delivery charges not applicable for non-serviceable locations`);
        }
      });
    }

    onSelect.quote.breakup.forEach((element: any, i: number) => {
      const titleType: any = element["@ondc/org/title_type"];
      const itemId = element["@ondc/org/item_id"];

      if (titleType !== "item" && titleType !== "offer" && !Object.values(retailPymntTtl).includes(titleType)) {
        addError(result, 22507, `Quote breakup Payment title type "${titleType}" is not as per the API contract`);
      }

      if (titleType !== "item" && titleType !== "offer" && !(element.title.toLowerCase().trim() in retailPymntTtl)) {
        addError(result, 22507, `Quote breakup Payment title "${element.title}" is not as per the API Contract`);
      } else if (
        titleType !== "item" &&
        titleType !== "offer" &&
        retailPymntTtl[element.title.toLowerCase().trim()] !== titleType
      ) {
        addError(result,
          22507,
          `Quote breakup Payment title "${element.title}" comes under the title type "${retailPymntTtl[element.title.toLowerCase().trim()]}"`
        );
      }

      if (titleType === "item") {
        if (!(itemId in itemsIdList)) {
          addError(result, 20006, `item with id: ${itemId} in quote.breakup[${i}] does not exist in items[]`);
        }
        if (!element.item) {
          addError(result, 20006, `Item's unit price missing in quote.breakup for item id ${itemId}`);
        } else if (
          parseFloat(element.item.price.value) * parseInt(element["@ondc/org/item_quantity"].count) !=
          parseFloat(element.price.value)
        ) {
          addError(result, 20006, `Item's unit and total price mismatch for id: ${itemId}`);
        }
        if (itemId in itemsIdList && element["@ondc/org/item_quantity"].count != itemsIdList[itemId]) {
          addError(result,
            20008,
            `Count of item with id: ${itemId} does not match in /${constants.SELECT} & /${constants.ON_SELECT}`
          );
        }
        itemPrices.set(itemId, Math.abs(parseFloat(element.price.value)));
      }

      if (["tax", "discount"].includes(titleType)) {
        if (!(itemId in itemsIdList)) {
          addError(result,
            20006,
            `item with id: ${itemId} in quote.breakup[${i}] does not exist in items[] (should be a valid item id)`
          );
        }
      }

      if (["packing", "delivery", "misc"].includes(titleType)) {
        if (!fulfillmentIdArray.includes(itemId)) {
          addError(result,
            20006,
            `invalid id: ${itemId} in ${titleType} line item (should be a valid fulfillment_id)`
          );
        }
      }

      onSelectPrice += parseFloat(element.price.value);
      if (
        titleType === "item" ||
        (titleType === "tax" && !taxNotInlcusive.includes(itemsCtgrs[itemId]))
      ) {
        onSelectItemsPrice += parseFloat(element.price.value);
      }
    });

    onSelectPrice = parseFloat(onSelectPrice.toFixed(2));
    const quotedPrice = parseFloat(onSelect.quote.price.value);
    if (Math.round(onSelectPrice) !== Math.round(quotedPrice)) {
      addError(result,
        20006,
        `quote.price.value ${quotedPrice} does not match with the price breakup ${onSelectPrice}`
      );
    }

    if (selectedPrice && typeof selectedPrice === "number" && onSelectItemsPrice !== selectedPrice) {
      addError(result,
        20006,
        `Quoted Price in /${constants.ON_SELECT} INR ${onSelectItemsPrice} does not match with the total price of items in /${constants.SELECT} INR ${selectedPrice}`
      );
    }

    let quoteObj = { ...onSelect.quote };
    quoteObj  = structuredClone(quoteObj);
    quoteObj.breakup.forEach((element: any) => {
      if (element["@ondc/org/title_type"] === "item" && element.item?.quantity) {
        delete element.item.quantity;
      }
    });

    await Promise.all([
      setRedisValue(`${transaction_id}_quoteObj`, quoteObj, TTL_IN_SECONDS),
      setRedisValue(`${transaction_id}_onSelectPrice`, quotedPrice, TTL_IN_SECONDS),
      setRedisValue(`${transaction_id}_selectPriceMap`, Array.from(itemPrices.entries()), TTL_IN_SECONDS),
    ]);

    const parentItemIds = onSelect.items
      .map((item: any) => item.parent_item_id)
      .filter((id: any) => id);
    const parentItemIdsQuotes = onSelect.quote.breakup
      .map((breakupItem: any) => breakupItem.item?.parent_item_id)
      .filter((id: any) => id);

    parentItemIdsQuotes.forEach((quoteParentId: string, index: number) => {
      if (!parentItemIds.includes(quoteParentId)) {
        addError(result,
          20006,
          `parent_item_id '${quoteParentId}' in quote.breakup[${index}] is not present in items array`
        );
      }
    });
  } catch (error: any) {
    console.error(`Error while checking quote in /${constants.ON_SELECT}, ${error.stack}`);
    addError(result, 23001, `Internal Error: ${error.message}`);
  }
}

async function validateError(
  onSelect: any,
  transaction_id: string,
  result: ValidationError[],
) {
  if (!onSelect.error) return;

  try {
    console.info(`Checking error message in /${constants.ON_SELECT}`);
    const { error } = onSelect;
    const itemsIdListRaw = await RedisService.getKey(`${transaction_id}_itemsIdList`);
    const itemsIdList = itemsIdListRaw ? JSON.parse(itemsIdListRaw) : null;

    if (error.code === "40002") {
      let errorArray: any[] = [];
      try {
        errorArray = JSON.parse(error.message);
      } catch (err: any) {
        addError(result,
          20006,
          `The error.message provided in ${ApiSequence.ON_SELECT_OUT_OF_STOCK} should be a valid JSON array`
        );
        return;
      }

      if (!Array.isArray(errorArray)) {
        addError(result,
          20006,
          `The error.message provided in ${ApiSequence.ON_SELECT_OUT_OF_STOCK} should be an array`
        );
        return;
      }

      const breakup_msg = onSelect.quote.breakup;



     

      const itemsReduced = breakup_msg.filter(
        (item: any) =>
          item["@ondc/org/item_quantity"] &&
          item["@ondc/org/item_quantity"].count < itemsIdList[item["@ondc/org/item_id"]]
      );

    

      errorArray.forEach((errorItem: any) => {
        const isPresent = itemsReduced.some(
          (item: any) => item["@ondc/org/item_id"] === errorItem.item_id
        );
        if (!isPresent && errorItem.item_id) {
          addError(result,
            20006,
            `Item isn't reduced ${errorItem.item_id} in error message is not present in fulfillments/items`
          );
        }
      });

      itemsReduced.forEach((item: any) => {
        const isPresent = errorArray.some(
          (errorItem: any) => errorItem.item_id === item["@ondc/org/item_id"]
        );
        if (!isPresent) {
          addError(result,
            20006,
            `message/order/items for item ${item["@ondc/org/item_id"]} does not match in error message`
          );
        }
      });
    }
  } catch (error: any) {
    console.error(`Error while checking error message in /${constants.ON_SELECT}, ${error.stack}`);
    addError(result, 20006, `Error while checking error message: ${error.message}`);
  }
}

export async function onSelect(data: any) {
  const { context, message } = data;
  const result: ValidationError[] = [];
  const txnId = context?.transaction_id;

  try {
    await contextChecker(context, result, constants.ON_SELECT, constants.SELECT);
  } catch (err: any) {
    addError(result, 20006, err.message);
    return result;
  }
  const isErrorObjectFound = data?.error;

  try {
    const onSelect = message.order;
    await setRedisValue(`${txnId}_${ApiSequence.ON_SELECT}`, data, TTL_IN_SECONDS);

    await validateProvider(onSelect, txnId, result);
    await validateItems(onSelect, txnId, result);
    const { nonServiceableFlag } = await validateFulfillments(onSelect, txnId, result, context.timestamp);
    !isErrorObjectFound && await validateQuote(onSelect, txnId, result, nonServiceableFlag);
    await validateError(onSelect, txnId, result);

    return result;
  } catch (error: any) {
    console.error(`Error in /${constants.ON_SELECT}: ${error.stack}`);
    addError(result, 23001, `Internal Error: ${error.message}`);
    return result;
  }
}