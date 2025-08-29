import { RedisService } from "ondc-automation-cache-lib";
import { contextChecker } from "./../utils/contextUtils";
import { compareObjects, getRedisValue, tagFinder } from "./../utils/helper";
import constants, { ApiSequence } from "./../utils/constants";
import _ from "lodash";

const TTL_IN_SECONDS: number = Number(process.env.TTL_IN_SECONDS) || 3600;

const addError = (result: any[], code: number, description: string): void => {
  result.push({
    valid: false,
    code,
    description,
  });
};

// Store billing object
const storeBilling = async (txnId: string, billing: any, result: any[]): Promise<void> => {
  try {
    await RedisService.setKey(`${txnId}_billing`, JSON.stringify(billing), TTL_IN_SECONDS);
  } catch (err: any) {
    addError(result, 40000, `Business Error: Error storing billing: ${err.message}`);
  }
};

// Store applicable offers
const storeApplicableOffers = async (txnId: string, offers: any[], result: any[]): Promise<void> => {
  try {
    await RedisService.setKey(
      `${txnId}_${ApiSequence.INIT}_offers`,
      JSON.stringify(offers),
      TTL_IN_SECONDS
    );
  } catch (err: any) {
    addError(result, 40000, `Business Error: Error storing applicable offers: ${err.message}`);
  }
};

// Validate provider details
const validateProvider = async (txnId: string, provider: any, result: any[]): Promise<void> => {
  try {
    const providerId = await getRedisValue(`${txnId}_providerId`);
    if (providerId !== provider.id) {
      addError(result, 40000, `Business Error: Provider Id mismatches in /${constants.SELECT} and /${constants.INIT}`);
    }

    const providerLoc = await getRedisValue(`${txnId}_providerLoc`);
    const locationId = provider.locations?.[0]?.id;
    if (providerLoc !== locationId) {
      addError(result, 40000, `Business Error: Provider.locations[0].id mismatches in /${constants.SELECT} and /${constants.INIT}`);
    }
  } catch (err: any) {
    addError(result, 40000, `Business Error: Error validating provider: ${err.message}`);
  }
};

// Validate billing timestamps and comparison
const validateBilling = async (txnId: string, billing: any, context: any, result: any[]): Promise<void> => {
  try {
    const contextTime = new Date(context.timestamp).getTime();

    if (billing.created_at) {
      const billingTime = new Date(billing.created_at).getTime();
      if (isNaN(billingTime) || billingTime > contextTime) {
        addError(result, 40000, `Business Error: billing.created_at should not be greater than context.timestamp in /${constants.INIT}`);
      }
    }

    if (billing.updated_at) {
      const billingTime = new Date(billing.updated_at).getTime();
      if (isNaN(billingTime) || billingTime > contextTime) {
        addError(result, 40000, `Business Error: billing.updated_at should not be greater than context.timestamp in /${constants.INIT}`);
      }
    }

    if (billing.created_at && billing.updated_at && new Date(billing.updated_at) < new Date(billing.created_at)) {
      addError(result, 40000, `Business Error: billing.updated_at cannot be less than billing.created_at in /${constants.INIT}`);
    }

    const selectBilling = await getRedisValue(`${txnId}_billing_select`);
    if (selectBilling) {
      const billingErrors = compareObjects(selectBilling, billing);
      billingErrors?.forEach((error: string) => {
        addError(result, 40000, `Business Error: billing: ${error} when compared with /${constants.SELECT} billing object`);
      });
    }
  } catch (err: any) {
    addError(result, 40000, `Business Error: Error validating billing: ${err.message}`);
  }
};

// Validate items (IDs, quantities, parent_item_id, location_id)
const validateItems = async (txnId: string, items: any[], context: any, result: any[]): Promise<void> => {
  try {
    const itemsIdList = await getRedisValue(`${txnId}_itemsIdList`);
    const fulfillmentIdArray = await getRedisValue(`${txnId}_fulfillmentIdArray`);
    const parentItemIdSet = await getRedisValue(`${txnId}_parentItemIdSet`);
    const onSearchItems = await getRedisValue(`${txnId}_onSearchItems`);

    items.forEach((item: any, i: number) => {
      const itemId = item.id;

      // Validate item ID existence
      if (!(itemId in itemsIdList)) {
        addError(result, 30004, `Item not found: Item Id ${itemId} does not exist in /${constants.ON_SELECT}`);
      }

      // Validate fulfillment ID
      if (!fulfillmentIdArray?.includes(item.fulfillment_id)) {
        addError(result, 40000, `Business Error: items[${i}].fulfillment_id mismatches for Item ${itemId} in /${constants.ON_SELECT} and /${constants.INIT}`);
      }

      // Validate quantity
      if (itemId in itemsIdList && item.quantity.count !== itemsIdList[itemId]) {
        addError(result, 40000, `Business Error: items[${i}].quantity.count for item ${itemId} mismatches with /${constants.SELECT}`);
      }

      // Validate parent_item_id
      if (parentItemIdSet && item.parent_item_id && !parentItemIdSet.includes(item.parent_item_id)) {
        addError(result, 40000, `Business Error: items[${i}].parent_item_id mismatches for Item ${itemId} in /${constants.ON_SEARCH} and /${constants.INIT}`);
      }

      // Validate type and parent_item_id
      const typeTag = item.tags?.find((tag: any) => tag.code === "type");
      const typeValue = typeTag?.list?.find((listItem: any) => listItem.code === "type")?.value;
      const isItemType = typeValue === "item";
    });
  } catch (err: any) {
    addError(result, 40000, `Business Error: Error validating items: ${err.message}`);
  }
};

// Validate fulfillments (IDs, GPS, area_code)
const validateFulfillments = async (txnId: string, fulfillments: any[], result: any[]): Promise<void> => {
  try {
    const fulfillmentIdArray = await getRedisValue(`${txnId}_fulfillmentIdArray`);
    const buyerGps = await getRedisValue(`${txnId}_buyerGps`);
    const buyerAddr = await getRedisValue(`${txnId}_buyerAddr`);

    fulfillments.forEach((fulfillment: any, i: number) => {
      const id = fulfillment.id;
      if (!fulfillmentIdArray?.includes(id)) {
        addError(result, 40000, `Business Error: fulfillment id ${id} does not exist in /${constants.ON_SELECT}`);
      }

      const gps = fulfillment.end?.location?.gps;
      if (buyerGps && !_.isEqual(gps, buyerGps)) {
        addError(result, 40000, `Business Error: gps coordinates in fulfillments[${i}].end.location mismatch in /${constants.SELECT} & /${constants.INIT}`);
      }

      const areaCode = fulfillment.end?.location?.address?.area_code;
      if (buyerAddr && !_.isEqual(areaCode, buyerAddr)) {
        addError(result, 40000, `Business Error: address.area_code in fulfillments[${i}].end.location mismatch in /${constants.SELECT} & /${constants.INIT}`);
      }

      const address = fulfillment.end?.location?.address;
      if (address) {
        const lenName = address.name?.length || 0;
        const lenBuilding = address.building?.length || 0;
        const lenLocality = address.locality?.length || 0;

        if (lenName + lenBuilding + lenLocality >= 190) {
          addError(result, 40000, `Business Error: address.name + address.building + address.locality should be < 190 chars`);
        }

        if (lenBuilding <= 3) {
          addError(result, 40000, `Business Error: address.building should be > 3 chars`);
        }
        if (lenName <= 3) {
          addError(result, 40000, `Business Error: address.name should be > 3 chars`);
        }
        if (lenLocality <= 3) {
          addError(result, 40000, `Business Error: address.locality should be > 3 chars`);
        }

        if (
          address.building === address.locality ||
          address.name === address.building ||
          address.name === address.locality
        ) {
          addError(result, 40000, `Business Error: address.name, address.building, and address.locality should be unique`);
        }
      }
    });
  } catch (err: any) {
    addError(result, 40000, `Business Error: Error validating fulfillments: ${err.message}`);
  }
};

export const init = async (data: any) => {
  const { context, message } = data;
  const result: any = [];
  const txnId = context?.transaction_id;

  try {
    await contextChecker(context, result, constants.INIT, constants.ON_SELECT);
  } catch (err: any) {
    result.push({
      valid: false,
      code: 40000,
      description: `Business Error: ${err.message}`,
    });
    return result;
  }

  try {
    const order = message.order;

    await validateProvider(txnId, order.provider, result);
    await validateItems(txnId, order.items, context, result);
    await validateFulfillments(txnId, order.fulfillments, result);
    await validateBilling(txnId, order.billing, context, result);
    await storeBilling(txnId, order.billing, result);

    return result;
  } catch (err: any) {
    console.error(`Error occurred while checking /${constants.INIT} API, ${err.stack}`);
    addError(result, 50000, `Policy Error: ${err.message}`);
    return result;
  }
};

