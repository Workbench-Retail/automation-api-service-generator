

import constants, { ApiSequence } from "../utils/constants";
import { contextChecker } from "../utils/contextUtils";
import { RedisService } from "ondc-automation-cache-lib";
import _ from "lodash";
import {
  
  areTimestampsLessThanOrEqualTo,
  
} from "../utils/helper";

import { fashion } from "../utils/constants/fashion";

interface ValidationError {
  valid: boolean;
  code: number;
  description: string;
}

const TTL_IN_SECONDS = Number(process.env.TTL_IN_SECONDS) || 3600;

// Helper to add validation errors
const addError = (result: ValidationError[], code: number, description: string) => {
  result.push({ valid: false, code, description });
};



// Validate providers and their components
async function validateProviders(
  providers: any[],
  context: any,
  result: ValidationError[]
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
      addError(result, 20003, `Duplicate provider id: ${provider.id} in bpp/providers`);
    } else {
      prvdrsId.add(provider.id);
    }

    if (provider.rating !== undefined) {
      const numericRating = parseFloat(provider.rating);
      if (isNaN(numericRating) || numericRating < 1 || numericRating > 5) {
        addError(result, 40000, "provider.rating must be a number between 1 and 5");
      }
    }

    const providerTime = new Date(provider.time?.timestamp).getTime();
    const contextTimestamp = new Date(context.timestamp).getTime();
    if (providerTime > contextTimestamp) {
      addError(result, 20006, "store enable/disable timestamp should be <= context.timestamp");
    }

 
  

    provider.fulfillments?.forEach((ff: any) => {
      onSearchFFIdsArray.add(ff.id);
      
    });

    provider.locations?.forEach((loc: any, locIndex: number) => {
      if (prvdrLocId.has(loc.id)) {
        addError(result, 20004, `Duplicate location id: ${loc.id} in bpp/providers[${index}]/locations[${locIndex}]`);
      } else {
        prvdrLocId.add(loc.id);
      }

      

      

  
     
      if (loc.time?.range) {
        const start = parseInt(loc.time.range.start);
        const end = parseInt(loc.time.range.end);
        if (isNaN(start) || isNaN(end) || start > end || end > 2359) {
          addError(result, 20006, `end time must be > start time in bpp/providers[${index}]/locations[${locIndex}]`);
        }
      }
    });

    provider.categories?.forEach((category: any) => {
      if (categoriesId.has(category.id)) {
        addError(result, 20006, `Duplicate category id: ${category.id} in bpp/providers[${index}]`);
      } else {
        categoriesId.add(category.id);
      }
    
    });

    
    provider.items?.forEach((item: any, itemIndex: number) => {
      if (itemsId.has(item.id)) {
        addError(result, 20005, `Duplicate item id: ${item.id} in bpp/providers[${index}]`);
      } else {
        itemsId.add(item.id);
      }
      itemIdList.push(item.id);
      itemsArray.push(item);
      const categoryId = item.category_id as keyof typeof fashion;
      const categoryRules = fashion[categoryId]; 
      

      const attributesTag = item.tags?.find((tag: any) => tag.code === 'attribute');
      const attributes = attributesTag?.list || [];

      const attributeMap = new Map();
      attributes.forEach((attr: any) => {
        attributeMap.set(attr.code, attr.value);
      });

      for (const [code, rule] of Object.entries(categoryRules)) {
  const attrValue = attributeMap.get(code);

  if (rule.mandatory && (attrValue === undefined || attrValue === null || attrValue === '')) {
    addError(result, 20007, `Missing mandatory attribute '${code}' in item ${item.id}`);
    continue;
  }
  if('category_id' in item){
    itemCategoriesId.add(item.category_id);
  }

 
}

    
      if (item.fulfillment_id && !onSearchFFIdsArray.has(item.fulfillment_id)) {
        addError(result, 20006, `fulfillment_id in bpp/providers[${index}]/items[${itemIndex}] must map to a valid fulfillment id`);
      }
      if (item.location_id && !prvdrLocId.has(item.location_id)) {
        addError(result, 20006, `location_id in bpp/providers[${index}]/items[${itemIndex}] must map to a valid location id`);
      }

      if (item.time?.timestamp) {
        if (!areTimestampsLessThanOrEqualTo(item.time.timestamp, context.timestamp)) {
          addError(result, 20006, `item[${itemIndex}] timestamp can't be > context.timestamp`);
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
          addError(result, 20006, `Duplicate serviceability construct in bpp/providers[${index}]/tags[${tagIndex}]`);
        }
        serviceabilitySet.add(JSON.stringify(tag));

        const location = tag.list?.find((elem: any) => elem.code === "location")?.value;
        const category = tag.list?.find((elem: any) => elem.code === "category")?.value;
        if (location && !prvdrLocId.has(location)) {
          addError(result, 20006, `location in serviceability construct should be a valid location id in bpp/providers[${index}]`);
        }
        if (category && !itemCategoriesId.has(category)) {
          addError(result, 20006, `category in serviceability construct should be a valid category id in bpp/providers[${index}]`);
        }
      } else if (tag.code === "timing") {
        if (timingSet.has(JSON.stringify(tag))) {
          addError(result, 20006, `Duplicate timing construct in bpp/providers[${index}]/tags[${tagIndex}]`);
        }
        timingSet.add(JSON.stringify(tag));

        const timingFields = tag.list || [];
        const dayFrom = timingFields.find((elem: any) => elem.code === "day_from")?.value;
        const dayTo = timingFields.find((elem: any) => elem.code === "day_to")?.value;
        const timeFrom = timingFields.find((elem: any) => elem.code === "time_from")?.value;
        const timeTo = timingFields.find((elem: any) => elem.code === "time_to")?.value;

       
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
  itemsArray: any[],
) {
  const itemProviderMap: Record<string, string[]> = {};
  message.catalog["bpp/providers"].forEach((provider: any) => {
    itemProviderMap[provider.id] = provider.items?.map((item: any) => item.id) || [];
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
    )
  ]);
}

export async function onSearch(data: any) {
  const { context, message } = data;
  const result: ValidationError[] = [];
  const txnId = context?.transaction_id;

  try {
    await contextChecker(context, result, constants.ON_SEARCH, constants.SEARCH);
  } catch (err: any) {
    console.log('Entered the block 2243', err);
     result.push({
      valid: false,
      code: 20000,
      description: err.message,
    });
    return result
  }

  try {

 
    const {
      prvdrsId,
      itemsId,
      prvdrLocId,
      onSearchFFIdsArray,
      categoriesId,
      itemIdList,
      itemsArray,
      itemCategoriesId
    } = await validateProviders(message.catalog["bpp/providers"] || [], context, result);

    validateServiceabilityAndTiming(message.catalog["bpp/providers"] || [], prvdrLocId, itemCategoriesId, result);



    await storeData(
      txnId,
      message,
      prvdrsId,
      itemsId,
      prvdrLocId,
      onSearchFFIdsArray,
      categoriesId,
      itemIdList,
      itemsArray,
    );

    return result;
  } catch (err: any) {
    console.error(`Error in /${constants.ON_SEARCH}: ${err.stack}`);
    addError(result, 50000, `Internal error: ${err.message}`);
    return result;
  }
}