import { RedisService } from "ondc-automation-cache-lib";
import constants, { ApiSequence } from "../utils/constants";
import { contextChecker } from "../utils/contextUtils";
import { setRedisValue, isoDurToSec } from "../utils/helper";
import _ from "lodash";

interface ValidationError {
  valid: boolean;
  code: number;
  description: string;
}

const TTL_IN_SECONDS: number = Number(process.env.TTL_IN_SECONDS) || 3600;

const addError = (
  result: ValidationError[],
  code: number,
  description: string
) => {
  result.push({ valid: false, code, description });
};

async function validateProvider(
  select: any,
  transaction_id: string,
  result: ValidationError[]
) {
  let providerOnSelect = null;
  try {
    console.log(
      `Checking for valid provider in /${constants.ON_SEARCH} and /${constants.SELECT}`
    );
    const onSearchRaw = await RedisService.getKey(
      `${transaction_id}_${ApiSequence.ON_SEARCH}_message`
    );
    const onSearch = onSearchRaw ? JSON.parse(onSearchRaw) : null;
    let provider = onSearch?.catalog["bpp/providers"].filter(
      (provider: { id: any }) => provider.id === select.provider.id
    );

    if (!provider || provider.length === 0) {
      addError(
        result,
        30001,
        `Provider not found - The provider ID provided in the request was not found`
      );
      return null;
    }

    providerOnSelect = provider[0];
    await Promise.all([
      setRedisValue(
        `${transaction_id}_providerGps`,
        providerOnSelect?.locations[0]?.gps,
        TTL_IN_SECONDS
      ),
      setRedisValue(
        `${transaction_id}_providerName`,
        providerOnSelect?.descriptor?.name,
        TTL_IN_SECONDS
      ),
    ]);

    if (providerOnSelect?.locations[0]?.id !== select.provider?.locations[0]?.id) {
      addError(result,
        30002,
        `provider.locations[0].id ${providerOnSelect.locations[0].id}, Provider location not found - The provider location ID provided in the request was not found in /${constants.ON_SEARCH} and /${constants.SELECT}`
      );
    }

    if (providerOnSelect?.time && providerOnSelect?.time?.label === "disable") {
      addError(result, 40000, `provider with provider.id: ${providerOnSelect.id} was disabled in on_search`);
    }
  } catch (error: any) {
    console.error(`Error while checking for valid provider in /${constants.ON_SEARCH} and /${constants.SELECT}, ${error.stack}`);
    addError(result, 40000, `Error while checking provider: ${error.message}`);
  }
  return providerOnSelect;
}

async function validateFulfillment(
  select: any,
  transaction_id: string,
  result: ValidationError[]
) {
  try {
    console.log(`Checking for GPS precision in /${constants.SELECT}`);
    select.fulfillments?.forEach(async (ff: any) => {
      if (ff.hasOwnProperty("end")) {
        await Promise.all([
          setRedisValue(
            `${transaction_id}_buyerGps`,
            ff.end?.location?.gps,
            TTL_IN_SECONDS
          ),
          setRedisValue(
            `${transaction_id}_buyerAddr`,
            ff.end?.location?.address?.area_code,
            TTL_IN_SECONDS
          ),
        ]);
      }
    });
  } catch (error: any) {
    console.error(`!!Error while checking GPS Precision in /${constants.SELECT}, ${error.stack}`);
    addError(result, 40000, `Error while checking fulfillment: ${error.message}`);
  }
}

async function validateItem(
  select: any,
  transaction_id: string,
  result: ValidationError[]
) {
  const itemIdArray: string[] = [];
  const itemsOnSelect: string[] = [];
  const itemsIdList: any = {};
  const itemsCtgrs: any = {};
  const itemsTat: any[] = [];
  let selectedPrice = 0;

  try {
    console.log(`Storing item IDs and their count in /${constants.SELECT}`);
    const itemsOnSearchRaw = await RedisService.getKey(
      `${transaction_id}_${ApiSequence.ON_SEARCH}itemsId`
    );
    const itemsOnSearch = itemsOnSearchRaw ? JSON.parse(itemsOnSearchRaw) : [];

    select.items.forEach((item: { id: string | number; quantity: { count: number } }) => {
      if (itemsOnSearch.length > 0 && !itemsOnSearch?.includes(item.id.toString())) {
        addError(result, 30004, `Item not found - The item ID provided in the request was not found: ${item.id}`);
      }
      itemIdArray.push(item.id.toString());
      itemsOnSelect.push(item.id.toString());
      itemsIdList[item.id] = item.quantity.count;
    });

    await Promise.all([
      setRedisValue(
        `${transaction_id}_itemsIdList`,
        itemsIdList,
        TTL_IN_SECONDS
      ),
      setRedisValue(
        `${transaction_id}_SelectItemList`,
        itemsOnSelect,
        TTL_IN_SECONDS
      ),
    ]);
  } catch (error: any) {
    console.error(`Error while storing item IDs in /${constants.SELECT}, ${error.stack}`);
    addError(result, 40000, `Error while storing item IDs: ${error.message}`);
  }

  try {
    console.log(`Checking for valid and present location ID inside item list for /${constants.SELECT}`);

    const itemProviderMapRaw = await RedisService.getKey(
      `${transaction_id}_itemProviderMap`
    );
    const itemProviderMap = itemProviderMapRaw
      ? JSON.parse(itemProviderMapRaw)
      : {};
    const providerID = select.provider.id;
    select.items.forEach((item: any, index: number) => {
      if (itemProviderMap.length > 0 && !itemProviderMap[providerID]?.includes(item.id)) {
        addError(result,
          30004,
          `Item with id ${item.id} not found - The item ID provided in the request was not found with provider_id ${providerID}`
        );
      }
    });
  } catch (error: any) {
    console.error(`Error while checking for valid and present location ID inside item list for /${constants.SELECT}, ${error.stack}`);
    addError(result, 40000, `Error while checking item location/provider: ${error.message}`);
  }

  try {
    console.log(
      `Mapping the items with their prices on /${constants.ON_SEARCH} and /${constants.SELECT}`
    );
    const allOnSearchItemsRaw = await RedisService.getKey(
      `${transaction_id}_onSearchItems`
    );
    const allOnSearchItems = allOnSearchItemsRaw
      ? JSON.parse(allOnSearchItemsRaw)
      : [];
    let onSearchItems = allOnSearchItems.flat();
    select.items.forEach((item: any) => {
      const onSearchItem = onSearchItems.find((it: any) => it.id === item.id);
      if (onSearchItem) {
        itemsCtgrs[item.id] = onSearchItem.category_id;
        itemsTat.push(onSearchItem["@ondc/org/time_to_ship"]);

        if (
          onSearchItem.quantity?.available?.count &&
          onSearchItem.quantity?.maximum?.count
        ) {
          const availableCount =
            onSearchItem.quantity.available.count === "99"
              ? Infinity
              : parseInt(onSearchItem.quantity.available.count);
          const maximumCount =
            onSearchItem.quantity.maximum.count === "99"
              ? Infinity
              : parseInt(onSearchItem.quantity.maximum.count);
          const selectedQuantity = parseInt(item.quantity.count);

          if (selectedQuantity > 0) {
            if (
              !(
                selectedQuantity <= availableCount &&
                selectedQuantity <= maximumCount
              )
            ) {
              addError(result,
                40009,
                `Maximum order qty exceeded - The maximum order quantity has been exceeded for the item.id: ${item.id}`
              );
            }
          } else {
            addError(result,
              40012,
              `Minimum order qty required - The minimum order quantity has not been met for the item.id: ${item.id}`
            );
          }

          selectedPrice += onSearchItem.price.value * item.quantity?.count;
        }
      }
    });
    const provider_id = select.provider.id;

    let orderValueData = await RedisService.getKey(
      `${transaction_id}_${ApiSequence.ON_SEARCH}_orderValueSet`
    );
    if (!_.isNull(orderValueData)) {
      const parsedData: any[] = JSON.parse(orderValueData) || [];
      const min_value =
        parsedData?.find((itm: any) => itm.provider_id === provider_id)
          ?.value || 0;

      if (selectedPrice < min_value) {
        addError(result,
          30023,
          `Minimum order value error - The cart value is less than the minimum order value (${selectedPrice} < ${min_value})`
        );
      }
    }
    await Promise.all([
      setRedisValue(
        `${transaction_id}_selectedPrice`,
        selectedPrice,
        TTL_IN_SECONDS
      ),
      setRedisValue(`${transaction_id}_itemsCtgrs`, itemsCtgrs, TTL_IN_SECONDS),
    ]);
  } catch (error: any) {
    console.error(`Error while mapping the items with their prices on /${constants.ON_SEARCH} and /${constants.SELECT}, ${error.stack}`);
    addError(result, 40000, `Error while mapping item prices: ${error.message}`);
  }

  try {
    console.log(`Saving time_to_ship in /${constants.SELECT}`);
    let timeToShip = 0;
    itemsTat?.forEach((tts: any) => {
      const ttship = isoDurToSec(tts);
      timeToShip = Math.max(timeToShip, ttship);
    });
    await setRedisValue(
      `${transaction_id}_timeToShip`,
      timeToShip,
      TTL_IN_SECONDS
    );
  } catch (error: any) {
    console.error(`!!Error while saving time_to_ship in ${constants.SELECT}, ${error.stack}`);
    addError(result, 40000, `Error while saving time_to_ship: ${error.message}`);
  }

  return { itemIdArray, itemsOnSelect, itemsIdList, itemsCtgrs, selectedPrice };
}

export async function select(data: any) {
  const { context, message } = data;
  const result: ValidationError[] = [];
  const txnId = context?.transaction_id;

  try {
    await contextChecker(
      context,
      result,
      constants.SELECT,
      constants.SELECT
    );
  } catch (err: any) {
    console.log('Entered the block 2243', err);
     result.push({
      valid: false,
      code: 40000,
      description: err.message,
    });
    return result
  }

  try {
    const select = message.order;

    await Promise.all([
      setRedisValue(`${txnId}_${ApiSequence.SELECT}`, data, TTL_IN_SECONDS),
      setRedisValue(`${txnId}_providerId`, select.provider.id, TTL_IN_SECONDS),
      setRedisValue(
        `${txnId}_providerLoc`,
        select.provider.locations[0].id,
        TTL_IN_SECONDS
      ),
      setRedisValue(`${txnId}_items`, select.items, TTL_IN_SECONDS),
    ]);

    await validateFulfillment(select, txnId, result);
    await validateItem(select, txnId, result);

    return result;
  } catch (error: any) {
    console.error(`Error in /${constants.SELECT}: ${error.stack}`);
    addError(result, 50000, `Internal error: ${error.message}`);
    return result;
  }
}
