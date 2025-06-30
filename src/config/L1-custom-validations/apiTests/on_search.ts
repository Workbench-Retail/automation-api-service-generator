import constants, { ApiSequence } from "../utils/constants";
import { contextChecker } from "../utils/contextUtils";
import { RedisService } from "ondc-automation-cache-lib";
import _ from "lodash";

import { areTimestampsLessThanOrEqualTo } from "../utils/helper";
import { electronicsData } from "../utils/constants/electronics";

interface ValidationError {
  valid: boolean;
  code: number;
  description: string;
}

const TTL_IN_SECONDS = Number(process.env.TTL_IN_SECONDS) || 3600;

const addError = (
  result: ValidationError[],
  code: number,
  description: string
) => {
  result.push({ valid: false, code, description });
};

async function validateProviders(
  providers: any[],
  context: any,
  result: ValidationError[],
  isSearchIncr: any
): Promise<{
  prvdrsId: Set<string>;
  itemsId: Set<string>;
  prvdrLocId: Set<string>;
  onSearchFFIdsArray: Set<string>;
  categoriesId: Set<string>;
  itemIdList: string[];
  itemsArray: any[];
  itemCategoriesId: Set<string>;
}> {
  const prvdrsId = new Set<string>();
  const itemsId = new Set<string>();
  const prvdrLocId = new Set<string>();
  const onSearchFFIdsArray = new Set<string>();
  const categoriesId = new Set<string>();
  const itemIdList: string[] = [];
  const itemsArray: any[] = [];
  const itemCategoriesId = new Set<string>();

  for (const [index, provider] of providers.entries()) {
    if (prvdrsId.has(provider.id)) {
      addError(
        result,
        20003,
        `Duplicate provider id: ${provider.id} in bpp/providers`
      );
    } else {
      prvdrsId.add(provider.id);
    }

    if (provider.rating !== undefined) {
      const numericRating = parseFloat(provider.rating);
      if (isNaN(numericRating) || numericRating < 1 || numericRating > 5) {
        addError(
          result,
          20006,
          "provider.rating must be a number between 1 and 5"
        );
      }
    }

    const providerTime = new Date(provider.time?.timestamp).getTime();
    const contextTimestamp = new Date(context.timestamp).getTime();
    if (providerTime > contextTimestamp) {
      addError(
        result,
        20006,
        "store enable/disable timestamp should be <= context.timestamp"
      );
    }

    provider.fulfillments?.forEach((ff: any) => {
      onSearchFFIdsArray.add(ff.id);
    });

    provider.locations?.forEach((loc: any, locIndex: number) => {
      if (prvdrLocId.has(loc.id)) {
        addError(
          result,
          20004,
          `Duplicate location id: ${loc.id} in bpp/providers[${index}]/locations[${locIndex}]`
        );
      } else {
        prvdrLocId.add(loc.id);
      }

      if (loc.time?.range) {
        const start = parseInt(loc.time.range.start);
        const end = parseInt(loc.time.range.end);
        if (isNaN(start) || isNaN(end) || start > end || end > 2359) {
          addError(
            result,
            20006,
            `end time must be > start time in bpp/providers[${index}]/locations[${locIndex}]`
          );
        }
      }
    });

    provider.categories?.forEach((category: any) => {
      if (categoriesId.has(category.id)) {
        addError(
          result,
          20006,
          `Duplicate category id: ${category.id} in bpp/providers[${index}]`
        );
      } else {
        categoriesId.add(category.id);
      }
    });

    provider.items?.forEach((item: any, itemIndex: number) => {
      if (itemsId.has(item.id)) {
        addError(
          result,
          20005,
          `Duplicate item id: ${item.id} in bpp/providers[${index}]`
        );
      } else {
        itemsId.add(item.id);
      }
      itemIdList.push(item.id);
      itemsArray.push(item);
      const categoryId = item.category_id as keyof typeof electronicsData;
      const categoryRules = electronicsData[categoryId];

      const attributesTag = item.tags?.find(
        (tag: any) => tag.code === "attribute"
      );
      const attributes = attributesTag?.list || [];

      const attributeMap = new Map();
      attributes.forEach((attr: any) => {
        attributeMap.set(attr.code, attr.value);
      });

      for (const [code, rule] of Object.entries(categoryRules)) {
        const attrValue = attributeMap.get(code);

        if (
          rule.mandatory &&
          (attrValue === undefined || attrValue === null || attrValue === "")
        ) {
          addError(
            result,
            20007,
            `Missing mandatory attribute '${code}' in item ${item.id}`
          );
          continue;
        }
        if ("category_id" in item) {
          itemCategoriesId.add(item.category_id);
        }
      }

      if (
        !isSearchIncr &&
        item.fulfillment_id &&
        !onSearchFFIdsArray.has(item.fulfillment_id)
      ) {
        addError(
          result,
          20006,
          `fulfillment_id in bpp/providers[${index}]/items[${itemIndex}] must map to a valid fulfillment id`
        );
      }
      if (
        !isSearchIncr &&
        item.location_id &&
        !prvdrLocId.has(item.location_id)
      ) {
        addError(
          result,
          20006,
          `location_id in bpp/providers[${index}]/items[${itemIndex}] must map to a valid location id`
        );
      }

      if (item.time?.timestamp) {
        if (
          !areTimestampsLessThanOrEqualTo(
            item.time.timestamp,
            context.timestamp
          )
        ) {
          addError(
            result,
            20006,
            `item[${itemIndex}] timestamp can't be > context.timestamp`
          );
        }
      }
      const quantity = item?.quantity;
      if (quantity) {
        const minimum_qty = parseFloat(quantity?.minimum?.count);
        const maximum_qty = parseFloat(quantity?.maximum?.count);
        const available_qty = parseFloat(quantity?.available?.count);
        if (minimum_qty && maximum_qty && minimum_qty > maximum_qty) {
          addError(
            result,
            20006,
            `minimum quantity: ${minimum_qty} can't be greater than the maximum quantity: ${maximum_qty}`
          );
        }
        if (minimum_qty && available_qty && available_qty < minimum_qty) {
          addError(
            result,
            20006,
            `available quantity: ${available_qty} can't be less than the minimum quantity: ${minimum_qty}`
          );
        }
        if (maximum_qty && available_qty && available_qty < maximum_qty) {
          addError(
            result,
            20006,
            `maximum quantity: ${maximum_qty} can't be greater than the available quantity: ${available_qty}`
          );
        }
      }
    });

    provider.offers?.forEach((offer: any, offerIndex: number) => {
      const { id, descriptor, location_ids, item_ids, time, tags } = offer;

      if (!id || typeof id !== "string" || !id.trim()) {
        addError(result, 20006, `Missing or invalid 'id' in financing object`);
      }

      if (descriptor?.code !== "financing") {
        addError(result, 20006, `'descriptor.code' must be 'financing'`);
      }

      if (!Array.isArray(location_ids) || location_ids.length === 0) {
        addError(result, 20006, `Missing or empty 'location_ids'`);
      }

      if (!Array.isArray(item_ids) || item_ids.length === 0) {
        addError(result, 20006, `Missing or empty 'item_ids'`);
      }

      const start = time?.range?.start;
      const end = time?.range?.end;
      if (!start || isNaN(Date.parse(start))) {
        addError(result, 20006, `Invalid or missing 'time.range.start'`);
      }
      if (!end || isNaN(Date.parse(end))) {
        addError(result, 20006, `Invalid or missing 'time.range.end'`);
      }
      if (start && end && new Date(start) >= new Date(end)) {
        addError(result, 20006, `'time.range.start' must be before 'end'`);
      }

      const tagMap = new Map<string, any[]>();
      tags?.forEach((tag:any) => {
        if (tag.code && Array.isArray(tag.list)) {
          tagMap.set(tag.code, tag.list);
        }
      });

      const meta = tagMap.get("meta");
      if (!meta) {
        addError(result, 20006, `Missing 'meta' tag`);
      } else {
        const additive = meta.find((item) => item.code === "additive")?.value;
        const auto = meta.find((item) => item.code === "auto")?.value;

        if (!["yes", "no"].includes(additive)) {
          addError(
            result,
            20006,
            `Invalid 'meta.additive': must be 'yes' or 'no'`
          );
        }
        if (!["yes", "no"].includes(auto)) {
          addError(result, 20006, `Invalid 'meta.auto': must be 'yes' or 'no'`);
        }
      }

      const financeTerms = tagMap.get("finance_terms");
      if (!financeTerms) {
        addError(result, 20006, `Missing 'finance_terms' tag`);
      } else {
        const subventionType = financeTerms.find(
          (item) => item.code === "subvention_type"
        )?.value;
        const subventionAmount = financeTerms.find(
          (item) => item.code === "subvention_amount"
        )?.value;

        if (!["percent", "amount"].includes(subventionType)) {
          addError(
            result,
            20006,
            `Invalid 'subvention_type': must be 'percent' or 'amount'`
          );
        }

        if (!subventionAmount || isNaN(parseFloat(subventionAmount))) {
          addError(
            result,
            20006,
            `Invalid 'subvention_amount': must be a numeric value`
          );
        }
      }
    });
  }

  return {
    prvdrsId,
    itemsId,
    prvdrLocId,
    onSearchFFIdsArray,
    categoriesId,
    itemIdList,
    itemsArray,
    itemCategoriesId,
  };
}
async function validateDescriptor(
  descriptor: any,
  context: any,
  result: ValidationError[]
): Promise<{
  descriptorName: Set<string>;
}> {
  const descriptorName = new Set<string>();
  const errors: ValidationError[] = result || [];

  if (!descriptor || typeof descriptor !== "object") {
    addError(
      errors,
      20000,
      "Invalid catalog - Descriptor must be a non-empty object in bpp/descriptor"
    );
    return { descriptorName };
  }

  const requiredFields = [
    "name",
    "symbol",
    "short_desc",
    "long_desc",
    "images",
    "tags",
  ];
  requiredFields.forEach((field) => {
    if (!descriptor[field]) {
      addError(
        errors,
        20006,
        `Invalid response - Missing required field: ${field} in bpp/descriptor`
      );
    }
  });

  if (descriptor.name) {
    if (typeof descriptor.name !== "string" || descriptor.name.trim() === "") {
      addError(
        errors,
        20006,
        "Invalid response - name must be a non-empty string in bpp/descriptor"
      );
    } else {
      descriptorName.add(descriptor.name);
    }
  }

  if (descriptor.symbol) {
    try {
      new URL(descriptor.symbol);
    } catch {
      addError(
        errors,
        20006,
        "Invalid response - symbol must be a valid URL in bpp/descriptor"
      );
    }
  }

  if (descriptor.short_desc && typeof descriptor.short_desc !== "string") {
    addError(
      errors,
      20006,
      "Invalid response - short_desc must be a non-empty string in bpp/descriptor"
    );
  }
  if (descriptor.long_desc && typeof descriptor.long_desc !== "string") {
    addError(
      errors,
      20006,
      "Invalid response - long_desc must be a non-empty string in bpp/descriptor"
    );
  }

  if (descriptor.images) {
    if (!Array.isArray(descriptor.images)) {
      addError(
        errors,
        20006,
        "Invalid response - images must be an array in bpp/descriptor"
      );
    } else if (descriptor.images.length === 0) {
      addError(
        errors,
        20006,
        "Invalid response - images array cannot be empty in bpp/descriptor"
      );
    } else {
      descriptor.images.forEach((image: string, index: number) => {
        try {
          new URL(image);
        } catch {
          addError(
            errors,
            20006,
            `Invalid response - images[${index}] must be a valid URL in bpp/descriptor`
          );
        }
      });
    }
  }

  if (descriptor.tags) {
    if (!Array.isArray(descriptor.tags)) {
      addError(
        errors,
        20006,
        "Invalid response - tags must be an array in bpp/descriptor"
      );
    } else {
      descriptor.tags.forEach((tag: any, tagIndex: number) => {
        if (
          !tag.code ||
          typeof tag.code !== "string" ||
          tag.code.trim() === ""
        ) {
          addError(
            errors,
            20006,
            `Invalid response - tags[${tagIndex}].code must be a non-empty string in bpp/descriptor`
          );
        }
        if (!Array.isArray(tag.list)) {
          addError(
            errors,
            20006,
            `Invalid response - tags[${tagIndex}].list must be an array in bpp/descriptor`
          );
        } else {
          tag.list.forEach((item: any, itemIndex: number) => {
            if (
              !item.code ||
              typeof item.code !== "string" ||
              item.code.trim() === ""
            ) {
              addError(
                errors,
                20006,
                `Invalid response - tags[${tagIndex}].list[${itemIndex}].code must be a non-empty string in bpp/descriptor`
              );
            }
            if (
              !item.value ||
              typeof item.value !== "string" ||
              item.value.trim() === ""
            ) {
              addError(
                errors,
                20006,
                `Invalid response - tags[${tagIndex}].list[${itemIndex}].value must be a non-empty string in bpp/descriptor`
              );
            }
          });
        }

        if (tag.code === "bpp_terms") {
          const npType = tag.list.find((item: any) => item.code === "np_type");
          const collectPayment = tag.list.find(
            (item: any) => item.code === "collect_payment"
          );

          if (!npType) {
            addError(
              errors,
              20006,
              `Invalid response - bpp_terms must contain np_type in bpp/descriptor/tags[${tagIndex}]`
            );
          } else if (npType.value !== "MSN" && npType.value !== "ISN") {
            addError(
              errors,
              20006,
              `Invalid response - np_type must be "MSN", "ISN" in bpp/descriptor/tags[${tagIndex}]`
            );
          }

          if (!collectPayment) {
          } else if (!["Y", "N"].includes(collectPayment.value)) {
            addError(
              errors,
              20006,
              `Invalid response - collect_payment must be "Y" or "N" in bpp/descriptor/tags[${tagIndex}]`
            );
          }
        }
      });
    }
  }

  if (context?.timestamp) {
    const contextTimestamp = new Date(context.timestamp).getTime();
    if (isNaN(contextTimestamp)) {
      addError(
        errors,
        20006,
        "Invalid response - context.timestamp must be a valid date in bpp/descriptor"
      );
    }
  }

  return {
    descriptorName,
  };
}

function validateServiceabilityAndTiming(
  providers: any[],
  prvdrLocId: Set<string>,
  itemCategoriesId: Set<string>,
  result: ValidationError[]
) {
  providers.forEach((provider: any, index: number) => {
    const tags = provider.tags || [];
    const serviceabilitySet = new Set<string>();
    const timingSet = new Set<string>();

    tags.forEach((tag: any, tagIndex: number) => {
      if (tag.code === "serviceability") {
        if (serviceabilitySet.has(JSON.stringify(tag))) {
          addError(
            result,
            20006,
            `Duplicate serviceability construct in bpp/providers[${index}]/tags[${tagIndex}]`
          );
        }
        serviceabilitySet.add(JSON.stringify(tag));

        const location = tag.list?.find(
          (elem: any) => elem.code === "location"
        )?.value;
        const category = tag.list?.find(
          (elem: any) => elem.code === "category"
        )?.value;
        if (location && !prvdrLocId.has(location)) {
          addError(
            result,
            20006,
            `location in serviceability construct should be a valid location id in bpp/providers[${index}]`
          );
        }
        if (category && !itemCategoriesId.has(category)) {
          addError(
            result,
            20006,
            `category in serviceability construct should be a valid category id in bpp/providers[${index}]`
          );
        }
      } else if (tag.code === "timing") {
        if (timingSet.has(JSON.stringify(tag))) {
          addError(
            result,
            20006,
            `Duplicate timing construct in bpp/providers[${index}]/tags[${tagIndex}]`
          );
        }
        timingSet.add(JSON.stringify(tag));

        const timingFields = tag.list || [];
        const dayFrom = timingFields.find(
          (elem: any) => elem.code === "day_from"
        )?.value;
        const dayTo = timingFields.find(
          (elem: any) => elem.code === "day_to"
        )?.value;
        const timeFrom = timingFields.find(
          (elem: any) => elem.code === "time_from"
        )?.value;
        const timeTo = timingFields.find(
          (elem: any) => elem.code === "time_to"
        )?.value;

        const dayFromNum = parseInt(dayFrom);
        const dayToNum = parseInt(dayTo);
        if (
          isNaN(dayFromNum) ||
          isNaN(dayToNum) ||
          dayFromNum < 1 ||
          dayFromNum > 7 ||
          dayToNum < 1 ||
          dayToNum > 7
        ) {
          addError(
            result,
            20006,
            `day_from and day_to must be integers between 1 and 7 in bpp/providers[${index}]/tags[${tagIndex}]`
          );
        } else if (dayFromNum > dayToNum) {
          addError(
            result,
            20006,
            `day_from must be <= day_to in bpp/providers[${index}]/tags[${tagIndex}]`
          );
        }

        const timeFromNum = parseInt(timeFrom);
        const timeToNum = parseInt(timeTo);
        if (
          isNaN(timeFromNum) ||
          isNaN(timeToNum) ||
          timeFrom.length !== 4 ||
          timeTo.length !== 4 ||
          timeFromNum < 0 ||
          timeFromNum > 2359 ||
          timeToNum < 0 ||
          timeToNum > 2359
        ) {
          addError(
            result,
            20006,
            `time_from and time_to must be in HHMM format (0000-2359) in bpp/providers[${index}]/tags[${tagIndex}]`
          );
        } else if (dayFrom === dayTo && timeFromNum >= timeToNum) {
          addError(
            result,
            20006,
            `time_from must be < time_to for same-day timing in bpp/providers[${index}]/tags[${tagIndex}]`
          );
        }
      }
    });
  });
}

async function storeData(
  transactionId: string,
  message: any,
  prvdrsId: Set<string>,
  itemsId: Set<string>,
  prvdrLocId: Set<string>,
  onSearchFFIdsArray: Set<string>,
  categoriesId: Set<string>,
  itemIdList: string[],
  itemsArray: any[]
) {
  const itemProviderMap: Record<string, string[]> = {};
  message.catalog["bpp/providers"].forEach((provider: any) => {
    itemProviderMap[provider.id] =
      provider.items?.map((item: any) => item.id) || [];
  });

  await Promise.all([
    RedisService.setKey(
      `${transactionId}_onSearchFFIdsArray`,
      JSON.stringify([...onSearchFFIdsArray]),
      TTL_IN_SECONDS
    ),
    RedisService.setKey(
      `${transactionId}_ItemList`,
      JSON.stringify(itemIdList),
      TTL_IN_SECONDS
    ),
    RedisService.setKey(
      `${transactionId}_prvdrLocationIds`,
      JSON.stringify([...prvdrLocId]),
      TTL_IN_SECONDS
    ),
    RedisService.setKey(
      `${transactionId}_categoryIds`,
      JSON.stringify([...categoriesId]),
      TTL_IN_SECONDS
    ),
    RedisService.setKey(
      `${transactionId}_onSearchItems`,
      JSON.stringify(itemsArray),
      TTL_IN_SECONDS
    ),
    RedisService.setKey(
      `${transactionId}_${ApiSequence.ON_SEARCH}prvdrsId`,
      JSON.stringify([...prvdrsId]),
      TTL_IN_SECONDS
    ),
    RedisService.setKey(
      `${transactionId}_${ApiSequence.ON_SEARCH}itemsId`,
      JSON.stringify([...itemsId]),
      TTL_IN_SECONDS
    ),
    RedisService.setKey(
      `${transactionId}_itemProviderMap`,
      JSON.stringify(itemProviderMap),
      TTL_IN_SECONDS
    ),
    RedisService.setKey(
      `${transactionId}_${ApiSequence.ON_SEARCH}_message`,
      JSON.stringify(message)
    ),
  ]);
}
export async function onSearch(data: any) {
  const { context, message } = data;
  const result: ValidationError[] = [];
  const txnId = context?.transaction_id;

  try {
    await contextChecker(
      context,
      result,
      constants.ON_SEARCH,
      constants.SEARCH
    );
  } catch (err: any) {
    result.push({
      valid: false,
      code: 20000,
      description: err.message,
    });
    return result;
  }

  try {
    let isSearchIncr = false;
    if (context.city === "*") isSearchIncr = true;

    const {
      prvdrsId,
      itemsId,
      prvdrLocId,
      onSearchFFIdsArray,
      categoriesId,
      itemIdList,
      itemsArray,
      itemCategoriesId,
    } = await validateProviders(
      message.catalog["bpp/providers"] || [],
      context,
      result,
      isSearchIncr
    );

    validateServiceabilityAndTiming(
      message.catalog["bpp/providers"] || [],
      prvdrLocId,
      itemCategoriesId,
      result
    );
    !isSearchIncr && await validateDescriptor(
      message.catalog["bpp/descriptor"] || [],
      context,
      result
    );

    await storeData(
      txnId,
      message,
      prvdrsId,
      itemsId,
      prvdrLocId,
      onSearchFFIdsArray,
      categoriesId,
      itemIdList,
      itemsArray
    );

    return result;
  } catch (err: any) {
    console.error(`Error in /${constants.ON_SEARCH}: ${err.stack}`);
    addError(result, 20006, `Internal error: ${err.message}`);
    return result;
  }
}
