import _ from "lodash";
import constants, { ApiSequence, PAYMENT_STATUS } from "./constants";
import { RedisService } from "ondc-automation-cache-lib";
import { groceryCategoryMappingWithStatutory } from "./constants/category";
import { statutory_reqs } from "./enums";
import { data } from "./constants/AreacodeMap";
import { InputObject } from "./interface";
import { reasonCodes } from "./reasonCode";
import { createAuthorizationHeader as createAuthHeader } from "ondc-crypto-sdk-nodejs";
import axios from "axios";

type ObjectType = {
  [key: string]: string | string[];
};
interface ValidationError {
  valid: boolean;
  code: number;
  description: string;
}

type ValidationOutput = ValidationError[];

const TTL_IN_SECONDS: number = Number(process.env.TTL_IN_SECONDS) || 3600;

const getDecimalPrecision = (numberString: string) => {
  const parts = numberString.trim().split(".");
  return parts.length === 2 ? parts[1].length : 0;
};

export const isObjectEmpty = (obj: any) => {
  return Object.keys(obj).length === 0;
};

export function validateObjectString(obj: ObjectType): string | null {
  const errors: string[] = [];

  Object.entries(obj).forEach(([key, value]) => {
    if (typeof value === "string" && value.trim() === "") {
      errors.push(`'${key}'`);
    } else if (
      Array.isArray(value) &&
      value.some((v) => typeof v === "string" && v.trim() === "")
    ) {
      errors.push(`'${key}'`);
    }
  });

  if (errors.length > 0) {
    return `${errors.join(", ")} cannot be empty`;
  }

  return null;
}

export const hasProperty = (object: any, propetyName: string) => {
  return Object.prototype.hasOwnProperty.call(object, propetyName);
};

export const isValidISO8601Duration = (value: string): boolean => {
  const iso8601DurationRegex =
    /^P(?:\d+Y)?(?:\d+M)?(?:\d+D)?(?:T(?:\d+H)?(?:\d+M)?(?:\d+(?:\.\d+)?S)?)?$/;
  return iso8601DurationRegex.test(value) && value !== "P" && value !== "PT";
};

export const isValidUrl = (url: string) => {
  try {
    new URL(url);
    return true;
  } catch (error) {
    return false;
  }
};

export const checkTagConditions = async (
  message: any,
  context: any,
  apiSeq: string
) => {
  const TTL_IN_SECONDS: number = Number(process.env.TTL_IN_SECONDS) || 3600;

  const tags = [];

  const transactionId = context.transaction_id;

  if (message.intent?.tags) {
    const catalogIncTags = message.intent.tags.find(
      (tag: { code: string }) => tag.code === "catalog_inc"
    );

    if (catalogIncTags) {
      const startTimeTag = catalogIncTags.list.find(
        (tag: { code: string }) => tag.code === "start_time"
      );
      const endTimeTag = catalogIncTags.list.find(
        (tag: { code: string }) => tag.code === "end_time"
      );
      const modeTag = catalogIncTags.list.find(
        (tag: { code: string }) => tag.code === "mode"
      );

      if (modeTag) {
        await RedisService.setKey(
          `${transactionId}_multiIncSearch`,
          JSON.stringify(true),
          TTL_IN_SECONDS
        );
      }

      if (modeTag && apiSeq === ApiSequence.INC_SEARCH) {
        if (modeTag.value === "start" || modeTag.value === "stop") {
          await RedisService.setKey(
            `${transactionId}_${ApiSequence.INC_SEARCH}_push`,
            JSON.stringify(true),
            TTL_IN_SECONDS
          );
        }
      }

      if (modeTag && modeTag.value !== "start" && modeTag.value !== "stop") {
        tags.push(
          "/message/intent/tags/list/value should be one of start or stop"
        );
      }

      if (startTimeTag && endTimeTag) {
        const startTime = new Date(startTimeTag.value).getTime();
        const endTime = new Date(endTimeTag.value).getTime();
        const contextTime = new Date(context.timestamp).getTime();

        if (startTime >= contextTime) {
          tags.push(
            "/message/intent/tags/list/start_time/value cannot be greater than or equal to /context/timestamp"
          );
        }

        if (endTime > contextTime) {
          tags.push(
            "/message/intent/tags/list/end_time/value cannot be greater than /context/timestamp"
          );
        }

        if (endTime <= startTime) {
          tags.push(
            "/message/intent/tags/list/end_time/value cannot be less or equal to than /message/intent/tags/list/start_time/value"
          );
        }
      }
    }
  } else {
    tags.push("/message/intent should have a required property tags");
  }

  return tags.length ? tags : null;
};

export const timestampCheck = (date: string): any => {
  const dateParsed: any = new Date(Date.parse(date));
  if (!isNaN(dateParsed)) {
    if (dateParsed.toISOString() !== date) {
      return { err: "FORMAT_ERR" };
    }
  } else {
    return { err: "INVLD_DT" };
  }
};

export const checkContext = (
  data: {
    transaction_id: string;
    message_id: string;
    action: string;
    ttl: string;
    timestamp: string;
  },
  path: string
) => {
  if (!data) return;
  const errObj: any = {};

  if (data.transaction_id === data.message_id) {
    errObj.id_err = "transaction_id and message id can't be same";
  }

  if (data.action !== path) {
    errObj.action_err = `context.action should be ${path}`;
  }

  if (data.ttl && data.ttl !== constants.RET_CONTEXT_TTL) {
    errObj.ttl_err = `ttl = ${constants.RET_CONTEXT_TTL} as per the API Contract`;
  }

  if (data.timestamp) {
    const result = timestampCheck(data.timestamp);
    if (result?.err === "FORMAT_ERR") {
      errObj.timestamp_err =
        "Timestamp not in RFC 3339 (YYYY-MM-DDTHH:MN:SS.MSSZ) Format";
    } else if (result?.err === "INVLD_DT") {
      errObj.timestamp_err = "Timestamp should be in date-time format";
    }
  }

  return _.isEmpty(errObj)
    ? { valid: true, SUCCESS: "Context Valid" }
    : { valid: false, ERRORS: errObj };
};

export const addMsgIdToRedisSet = async (
  transactionId: string,
  messageId: string,
  action: string
): Promise<boolean> => {
  try {
    const key = `${transactionId}_msgId_map`;
    let msgMap: Record<string, string> = {};

    const existing = await RedisService.getKey(key);
    if (existing) {
      msgMap = JSON.parse(existing);
    }

    const existingAction = msgMap[messageId];

    if (existingAction) {
      return existingAction === action;
    }

    const isActionUsed = Object.values(msgMap).includes(action);
    if (isActionUsed) {
      return false;
    }

    msgMap[messageId] = action;
    await RedisService.setKey(key, JSON.stringify(msgMap), TTL_IN_SECONDS);
    return true;
  } catch (error: any) {
    console.error(`Error in addMsgIdToRedisSet: ${error.stack}`);
    throw error;
  }
};

export const addActionToRedisSet = async (
  transactionId: string,
  previousAction: string,
  presentAction: string
): Promise<boolean> => {
  try {
    const key = `${transactionId}_previousCall`;
    let existingSet: any = [];

    const existing = await RedisService.getKey(key);
    if (existing) {
      existingSet = JSON.parse(existing);
    }

    if (
      previousAction === presentAction ||
      (!_.isEmpty(existingSet) && existingSet.includes(previousAction))
    ) {
      existingSet?.push(presentAction);
      await RedisService.setKey(
        key,
        JSON.stringify(existingSet),
        TTL_IN_SECONDS
      );
      return true;
    }

    return false;
  } catch (error: any) {
    console.error(`Error in addActionToRedisSet: ${error.stack}`);
    throw error;
  }
};

export const emailRegex = (email: string) => {
  const emailRE = /^\S+@\S+\.\S+$/;
  return emailRE.test(email);
};

export const checkBppIdOrBapId = (input: string, type?: string) => {
  try {
    if (!input) {
      return `${type} Id is not present`;
    }

    if (
      input?.startsWith("https://") ||
      input.startsWith("www") ||
      input.startsWith("https:") ||
      input.startsWith("http")
    )
      return `context/${type}_id should not be a url`;
    return;
  } catch (e) {
    return e;
  }
};

export function checkServiceabilityType(tags: any[]) {
  for (let i = 0; i < tags.length; i++) {
    if (tags[i].code === "serviceability") {
      for (let j = 0; j < tags[i].list.length; j++) {
        if (tags[i].list[j].code === "type" && tags[i].list[j].value === "10") {
          return true;
        }
      }
    }
  }

  return false;
}

export function validateLocations(locations: any[], tags: any[]) {
  const errorObj = {};
  const validNumberRegex = /^[0-9]+$/;
  for (let i = 0; i < locations.length; i++) {
    const location = locations[i];
    if (!location.circle) {
      Object.assign(errorObj, {
        locationErr: `"circle" not present in location with ID ${location.id}`,
      });
    }

    const radius = location?.circle.radius;

    if (
      radius &&
      (radius?.unit !== "km" || !validNumberRegex.test(radius.value))
    ) {
      Object.assign(errorObj, {
        locationRadiusErr: `Invalid radius in location with ID ${location.id}`,
      });
      if (typeof radius !== "number") {
        Object.assign(errorObj, {
          radiusErr: `Radius entered should be a number`,
        });
      }
    }
    if (typeof radius === "number" && radius > 500) {
      Object.assign(errorObj, {
        radiusLimitErr:
          "Circle radius should not exceed 500 km for serviceability, even if it is PAN India.",
      });
    }

    for (let i = 0; i < tags.length; i++) {
      if (tags[i].code === "serviceability") {
        for (let j = 0; j < tags[i].list.length; j++) {
          if (
            tags[i].list[j].code === "val" &&
            tags[i].list[j].value !== radius.value
          ) {
            Object.assign(errorObj, {
              srvcabilityValErr: `value passed in serviceability tags[${i}] should be same as passed in location/circle`,
            });
          }
        }
      }
    }
  }

  return errorObj;
}

export function isSequenceValid(set: any) {
  const numbers: any = Array.from(set);

  if (numbers.length < 2) {
    return;
  }

  numbers.sort((a: number, b: number) => a - b); // Sort the numbers in ascending order.

  for (let i = 1; i < numbers.length; i++) {
    const current = parseInt(numbers[i]);
    const previous = parseInt(numbers[i - 1]);

    if (current !== previous + 1) {
      return false;
    }
  }

  return true;
}

export const isValidPhoneNumber = (value: string): boolean => {
  const phoneRegex = /^(\d{10}|\d{11})$/;
  if (value.startsWith("0")) {
    value = value.substring(1);
  }

  const val = value?.replace(/[^\d]/g, "");
  return phoneRegex.test(val);
};

export const checkMandatoryTags = (
  i: string,
  items: any,
  errorObj: any,
  categoryJSON: any,
  categoryName: string
) => {
  items.forEach((item: any, index: number) => {
    let attributeTag = null;
    let originTag = null;
    for (const tag of item.tags) {
      originTag = tag.code === "origin" ? tag : originTag;
      attributeTag = tag.code === "attribute" ? tag : attributeTag;
    }

    if (!originTag) {
      console.error(
        `Origin tag fields are missing for ${categoryName} item[${index}]`
      );
      const key = `missingOriginTag[${i}][${index}]`;
      errorObj[key] =
        `Origin tag fields are missing for ${categoryName} item[${index}]`;
    }

    if (!attributeTag && categoryName !== "Grocery") {
      console.error(
        `Attribute tag fields are missing for ${categoryName} item[${index}]`
      );
      const key = `missingAttributeTag[${i}][${index}]`;
      errorObj[key] =
        `Attribute tag fields are missing for ${categoryName} item[${index}]`;
      return;
    }

    if (attributeTag) {
      const tags = attributeTag.list;
      const ctgrID = item.category_id;

      if (categoryJSON.hasOwnProperty(ctgrID)) {
        console.info(
          `Checking for item tags for ${categoryName} item[${index}]`
        );
        const mandatoryTags = categoryJSON[ctgrID];
        const missingMandatoryTags: any[] = [];
        tags.forEach((tag: { code: string }) => {
          const tagCode = tag.code;
          if (!mandatoryTags[tagCode]) {
            missingMandatoryTags.push(tag.code);
          }
        });

        if (missingMandatoryTags.length > 0) {
          const key = `invalid_attribute[${i}][${index}]`;
          errorObj[key] =
            `Invalid attribute for item with category id: ${missingMandatoryTags.join(
              ", "
            )}`;
        } else {
          console.log(`All tag codes have corresponding valid attributes.`);
        }
        for (const tagName in mandatoryTags) {
          if (mandatoryTags.hasOwnProperty(tagName)) {
            const tagInfo = mandatoryTags[tagName];
            const isTagMandatory = tagInfo.mandatory;
            if (isTagMandatory) {
              let tagValue: any = null;
              let originalTag: any = null;
              const tagFound = tags.some((tag: any): any => {
                const res = tag.code === tagName.toLowerCase();
                if (res) {
                  tagValue = tag.value;
                  originalTag = tag.value;
                }
                return res;
              });
              if (!tagFound) {
                console.error(
                  `Mandatory tag field [${tagName.toLowerCase()}] missing for ${categoryName} item[${index}]`
                );
                const key = `missingTagsItem[${i}][${index}] : ${tagName.toLowerCase()}`;
                errorObj[key] =
                  `Mandatory tag field [${tagName.toLowerCase()}] missing for ${categoryName} item[${index}]`;
              } else {
                if (tagInfo.value.length > 0) {
                  let isValidValue = false;
                  let regexPattern = "";

                  if (Array.isArray(tagInfo.value)) {
                    isValidValue =
                      tagInfo.value.includes(originalTag) ||
                      tagInfo.value.includes(tagValue);
                  } else if (
                    typeof tagInfo.value === "string" &&
                    tagInfo.value.startsWith("/") &&
                    tagInfo.value.endsWith("/")
                  ) {
                    regexPattern = tagInfo.value.slice(1, -1);
                    const regex = new RegExp(regexPattern);
                    isValidValue =
                      regex.test(originalTag) || regex.test(tagValue);
                  }
                  if (!isValidValue) {
                    console.error(
                      `The item value can only be one of the possible values or match the regex pattern.`
                    );
                    const key = `InvldValueforItem[${i}][${index}] : ${tagName}`;
                    errorObj[key] =
                      `Invalid item value: [${originalTag}]. It must be one of the allowed values or match the regex pattern [${regexPattern}].`;
                  }
                }
              }
            }
          }
        }
      } else {
        const key = `invalidCategoryId${ctgrID}`;
        errorObj[key] = `Invalid category_id (${ctgrID}) for ${categoryName}`;
      }
    }
  });
  return errorObj;
};

export const compareSTDwithArea = (pincode: number, std: string): boolean => {
  return data.some((e: any) => e.Pincode === pincode && e["STD Code"] === std);
};

export function checkIdInUri(Uri: string, id: string): boolean {
  return Uri.includes(id);
}

export function validateBapUri(
  bapUri: string,
  bapId: string,
  result: ValidationOutput
): void {
  // if (!checkIdInUri(bapUri, bapId)) {
  //   result.push({
  //     valid: false,
  //     code: 20006,
  //     description: `Bap_id ${bapId} is not found in BapUri ${bapUri}`,
  //   });
  // }
}

export function validateBppUri(
  bppUri: string,
  bppId: string,
  result: ValidationOutput
): void {
  // if (!checkIdInUri(bppUri, bppId)) {
  //   result.push({
  //     valid: false,
  //     code: 20006,
  //     description: `Bpp_id ${bppId} is not found in BppUri ${bppUri}`,
  //   });
  // }
}

export function areTimestampsLessThanOrEqualTo(
  timestamp1: string,
  timestamp2: string
): boolean {
  const date1 = new Date(timestamp1).getTime();
  const date2 = new Date(timestamp2).getTime();
  return date1 <= date2;
}

export function getStatutoryRequirement(
  category: string
): statutory_reqs | undefined {
  return groceryCategoryMappingWithStatutory[category];
}

export function checkForStatutory(
  item: any,
  i: number,
  j: number,
  errorObj: any,
  statutory_req: string
) {
  const requiredFields: Record<string, string[]> = {
    "@ondc/org/statutory_reqs_prepackaged_food": [
      "nutritional_info",
      "additives_info",
      "brand_owner_FSSAI_license_no",
      "other_FSSAI_license_no",
      "importer_FSSAI_license_no",
    ],
    "@ondc/org/statutory_reqs_packaged_commodities": [
      "manufacturer_or_packer_name",
      "manufacturer_or_packer_address",
      "common_or_generic_name_of_commodity",
      "month_year_of_manufacture_packing_import",
    ],
  };

  if (
    !_.isEmpty(
      item[statutory_req] ||
        typeof item[statutory_req] !== "object" ||
        item[statutory_req] === null
    )
  ) {
    const data = item[statutory_req];
    requiredFields[statutory_req].forEach((field: any, k: number) => {
      if (typeof data[field] !== "string" || data[field].trim() === "") {
        Object.assign(errorObj, {
          [`prvdr${i}item${j}${field}${k}statutoryReq`]: `The item${j}/'${statutory_req}'/${field}${k} is missing or not a string in bpp/providers/items for /${constants.ON_SEARCH}`,
        });
      }
    });
  } else {
    Object.assign(errorObj, {
      [`prvdr${i}item${j}statutoryReq`]: `The following item/category_id is not having item${j}/'${statutory_req}' in bpp/providers for /${constants.ON_SEARCH}`,
    });
  }

  return errorObj;
}

export const checkGpsPrecision = (coordinates: string) => {
  try {
    const [lat, long] = coordinates.split(",");
    const latPrecision = getDecimalPrecision(lat);
    const longPrecision = getDecimalPrecision(long);
    const minPrecision = constants.DECIMAL_PRECISION || 4;

    const isLatValid = latPrecision >= minPrecision;
    const isLongValid = longPrecision >= minPrecision;

    return isLatValid && isLongValid ? true : { latPrecision, longPrecision };
  } catch (error) {
    console.error(error);
    return error;
  }
};

export function findItemByItemType(item: any) {
  const tags = item.tags;
  if (tags) {
    for (let j = 0; j < tags.length; j++) {
      if (
        tags[j].code === "type" &&
        tags[j].list &&
        tags[j].list.length === 1 &&
        tags[j].list[0].code === "type" &&
        tags[j].list[0].value === "item"
      ) {
        return item;
      }
    }
  }
}

export const isoDurToSec = (duration: string) => {
  const durRE =
    /P((\d+)Y)?((\d+)M)?((\d+)W)?((\d+)D)?T?((\d+)H)?((\d+)M)?((\d+)S)?/;

  const splitTime = durRE.exec(duration);
  if (!splitTime) {
    return 0;
  }

  const years = Number(splitTime?.[2]) || 0;
  const months = Number(splitTime?.[4]) || 0;
  const weeks = Number(splitTime?.[6]) || 0;
  const days = Number(splitTime?.[8]) || 0;
  const hours = Number(splitTime?.[10]) || 0;
  const minutes = Number(splitTime?.[12]) || 0;
  const seconds = Number(splitTime?.[14]) || 0;

  const result =
    years * 31536000 +
    months * 2628288 +
    weeks * 604800 +
    days * 86400 +
    hours * 3600 +
    minutes * 60 +
    seconds;

  return result;
};

export const fnbCategories = [
  "Baklava",
  "Bao",
  "Barbecue",
  "Biryani",
  "Bread",
  "Burger",
  "Cakes",
  "Chaat",
  "Cheesecakes",
  "Chicken",
  "Chicken wings",
  "Chips",
  "Coffee",
  "Cookies",
  "Crepes",
  "Dal",
  "Desserts",
  "Dhokla",
  "Dosa",
  "Doughnuts",
  "Eggs",
  "Energy Drinks",
  "Falafel",
  "Fresh Juice",
  "Fries",
  "Ice cream",
  "Idli",
  "Kabab",
  "Kachori",
  "Kulfi",
  "Lassi",
  "Meal bowl",
  "Mezze",
  "Mithai",
  "Momos",
  "Mutton",
  "Nachos",
  "Noodles",
  "Pakodas",
  "Pancakes",
  "Paneer",
  "Pasta",
  "Pastries",
  "Pie",
  "Pizza",
  "Poha",
  "Raita",
  "Rice",
  "Rolls",
  "Roti",
  "Salad",
  "Samosa",
  "Sandwich",
  "Seafood",
  "Shakes & Smoothies",
  "Soft Drink",
  "Soup",
  "Spring Roll",
  "Sushi",
  "Tacos",
  "Tandoori",
  "Tart",
  "Tea",
  "Thali",
  "Tikka",
  "Upma",
  "Uttapam",
  "Vada",
  "Vegetables",
  "Waffle",
  "Wrap",
  "Yogurt",
  "F&B",
];
export const taxNotInlcusive = [...fnbCategories];

export const timeDiff = (time1: any, time2: any) => {
  const dtime1: any = new Date(time1);
  const dtime2: any = new Date(time2);

  if (isNaN(dtime1 - dtime2)) return 0;
  else return dtime1 - dtime2;
};
export function checkItemTag(item: any, itemArray: any[]) {
  if (item.tags) {
    for (const tag of item.tags) {
      if (tag.code === "parent") {
        for (const list of tag.list) {
          if (list.code === "id" && !itemArray.includes(list.value)) {
            return true;
          }
        }
      }
    }
  }

  return false;
}

export function compareObjects(
  obj1: any,
  obj2: any,
  parentKey?: string
): string[] {
  const errors: string[] = [];

  if (obj1 == null || obj2 == null) {
    errors.push("One of the objects is undefined or null");
    return errors;
  }

  const keys1 = Object.keys(obj1 ?? {});
  const keys2 = Object.keys(obj2 ?? {});

  if (keys1?.length !== keys2?.length) {
    errors.push(`Key length mismatch for ${parentKey || "root"}`);
    return errors;
  }

  for (const key of keys1 ?? []) {
    const fullKey = parentKey ? `${parentKey}.${key}` : key;
    const val1 = obj1?.[key];
    const val2 = obj2?.[key];

    const areObjects =
      typeof val1 === "object" &&
      val1 !== null &&
      typeof val2 === "object" &&
      val2 !== null;

    if (areObjects) {
      const nestedErrors = compareObjects(val1, val2, fullKey);
      errors.push(...nestedErrors);
    } else if (val1 !== val2) {
      errors.push(`Key '${fullKey}' mismatch: ${val1} !== ${val2}`);
    }
  }

  return errors;
}

export function compareQuoteObjects(
  obj1: InputObject,
  obj2: InputObject,
  api1: string,
  api2: string
): string[] {
  const errors: string[] = [];

  // Compare root level properties
  const rootKeys1 = obj1 && Object.keys(obj1);
  const rootKeys2 = obj2 && Object.keys(obj2);

  if (rootKeys1.length !== rootKeys2.length) {
    errors.push(
      `The quote object length of ${api1} mismatches with the ${api2}`
    );
    return errors;
  }

  // Compare breakup array
  obj1.breakup.forEach((item1: any) => {
    const matchingItem = obj2.breakup.find((item2: any) => {
      const sameItemId =
        item1["@ondc/org/item_id"] === item2["@ondc/org/item_id"];
      const sameTitleType =
        item1["@ondc/org/title_type"] === item2["@ondc/org/title_type"];
      const sameParentItemId =
        !item1?.item?.parent_item_id ||
        item1?.item?.parent_item_id === item2?.item?.parent_item_id;
      return sameItemId && sameTitleType && sameParentItemId;
    });

    // if (!matchingItem || !deepCompare(item1, matchingItem)) {
    //   errors.push(
    //     `Mismatch found for item with item_id ${item1["@ondc/org/item_id"]} while comparing quote object of ${api1} and ${api2}`
    //   );
    // }
  });

  return errors;
}

function deepCompare(obj1: any, obj2: any): boolean {
  if (typeof obj1 !== "object" || typeof obj2 !== "object") {
    return obj1 === obj2;
  }

  const keys1 = Object.keys(obj1);
  const keys2 = Object.keys(obj2);

  if (keys1.length !== keys2.length) {
    return false;
  }

  for (const key of keys1) {
    if (!keys2.includes(key) || !deepCompare(obj1[key], obj2[key])) {
      return false;
    }
  }

  return true;
}
export function isTagsValid(tags: any[], entity: string): boolean {
  const termsObject = tags.find((tag: { code: string }) => tag.code === entity);

  // If termsObject is found, check the list
  if (termsObject) {
    const taxNumberObject = termsObject.list.find(
      (item: { code: string }) => item.code === "tax_number"
    );

    // If taxNumberObject is found, validate the value
    if (taxNumberObject) {
      const value = taxNumberObject.value;

      if (typeof value === "string" && value.length <= 15) {
        return true; // Value is valid
      }
    }
  }

  return false;
}

export const sumQuoteBreakUp = (quote: any) => {
  const totalPrice = Number(quote.price.value);
  let currentPrice = 0;
  quote.breakup.forEach((item: any) => {
    currentPrice += Number(item.price.value);
  });
  return Math.round(totalPrice) === Math.round(currentPrice);
};
export enum FLOW {
  FLOW1 = "1",
  FLOW2 = "2",
  FLOW2A = "2A",
  FLOW3 = "3",
  FLOW4 = "4",
  FLOW5 = "5",
  FLOW6 = "6",
  FLOW7 = "7",
  FLOW8 = "8",
  FLOW9 = "9",
}
export function areGSTNumbersMatching(
  tags1: any[],
  tags2: any[],
  termToMatch: string
): boolean {
  // Find the GST number in the first tags array based on the specified term
  const gstNumber1 = findGSTNumber(tags1, termToMatch);

  // Find the GST number in the second tags array based on the specified term
  const gstNumber2 = findGSTNumber(tags2, termToMatch);

  // Check if both GST numbers are the same

  if (typeof gstNumber2 === "string" && typeof gstNumber1 === "string")
    return gstNumber1 === gstNumber2;
  else return false;
}

function findGSTNumber(tags: any[], termToMatch: string): string | undefined {
  // Find the object with the specified term
  try {
    const termObject = tags.find((tag) => tag.code === termToMatch);

    // If termObject is found, check the list for the GST number
    if (termObject) {
      const taxNumberObject = termObject.list.find(
        (item: { code: string }) => item.code === "tax_number"
      );

      // If taxNumberObject is found, return the GST number
      if (taxNumberObject) {
        const value = taxNumberObject.value;

        if (typeof value === "string" && value.length <= 15) {
          return value; // Return the GST number
        }
      }
    }

    return undefined; // GST number not found or not valid
  } catch (error: any) {}

  return undefined;
}
export function areGSTNumbersDifferent(tags: any[]): boolean {
  // Find the "tax_number" in "bpp_terms"
  const bppTermsObject = tags.find((tag) => tag.code === "bpp_terms");
  const bppTaxNumber = findTaxNumber(bppTermsObject);

  // Find the "tax_number" in "bap_terms"
  const bapTermsObject = tags.find((tag) => tag.code === "bap_terms");
  const bapTaxNumber = findTaxNumber(bapTermsObject);

  // Check if both "tax_number" values are different
  if (typeof bppTaxNumber === "string" && typeof bapTaxNumber === "string")
    return bppTaxNumber === bapTaxNumber;
  else return false;
}

function findTaxNumber(termObject: any): string | undefined {
  if (termObject) {
    const taxNumberObject = termObject.list.find(
      (item: { code: string }) => item.code === "tax_number"
    );

    if (taxNumberObject) {
      const value = taxNumberObject.value;

      if (typeof value === "string") {
        return value;
      }
    }
  }

  return undefined;
}
export const compareCoordinates = (coord1: any, coord2: any) => {
  if (!coord1 || !coord2) return false;
  // Remove all spaces from the coordinates
  const cleanCoord1 = coord1.replace(/\s/g, "");
  const cleanCoord2 = coord2.replace(/\s/g, "");

  // Compare the cleaned coordinates
  return cleanCoord1 === cleanCoord2;
};
export function compareLists(list1: any[], list2: any[]): string[] {
  const errors: string[] = [];

  for (const obj1 of list1) {
    const matchingObj = list2.find((obj2) => obj2.code === obj1.code);

    if (!matchingObj) {
      if (obj1.code !== "np_type") {
        errors.push(
          `Code '${obj1.code}' present in first list but not in second list.`
        );
      }
    } else {
      if (obj1.value !== matchingObj.value) {
        errors.push(`Code '${obj1.code}' value not matching.`);
      }
    }
  }

  return errors;
}

export function compareTimeRanges(
  data1: any,
  action1: any,
  data2: any,
  action2: any
): string[] | null {
  const keys = ["start", "end"];
  const errors: string[] = [];

  keys.forEach((key) => {
    if (!data1[key]?.time?.range || !data2[key]?.time?.range) {
      errors.push(`/${key}/range is not provided in one or both objects`);
      return; // Skip comparison if range is not provided
    }

    const range1 = data1[key].time.range;
    const range2 = data2[key].time.range;

    if (
      !isValidTimestamp(range1.start) ||
      !isValidTimestamp(range1.end) ||
      !isValidTimestamp(range2.start) ||
      !isValidTimestamp(range2.end)
    ) {
      errors.push(`/${key}/range has invalid timestamp format`);
      return; // Skip comparison if timestamp format is invalid
    }

    if (range1.start !== range2.start) {
      errors.push(
        `/${key}/range/start_time "${range1.start}" of ${action1} mismatched with /${key}/range/start_time "${range2.start}" of ${action2}`
      );
    }

    if (range1.end !== range2.end) {
      errors.push(
        `/${key}/range/end_time "${range1.end}" of ${action1} mismatched with /${key}/range/end_time "${range2.end}" of ${action2}`
      );
    }
  });

  return errors.length === 0 ? null : errors;
}
export function compareFulfillmentObject(
  obj1: any,
  obj2: any,
  keys: string[],
  i: number,
  apiSeq: string
) {
  const errors: any[] = [];

  keys.forEach((key: string) => {
    if (_.isArray(obj1[key])) {
      obj1[key] = _.sortBy(obj1[key], ["code"]);
    }
    if (_.isArray(obj2[key])) {
      obj2[key] = _.sortBy(obj2[key], ["code"]);
    }

    if (!_.isEqual(obj1[key], obj2[key])) {
      if (
        typeof obj1[key] === "object" &&
        typeof obj2[key] === "object" &&
        Object.keys(obj1[key]).length > 0 &&
        Object.keys(obj2[key]).length > 0
      ) {
        const obj1_nested = obj1[key];
        const obj2_nested = obj2[key];

        const obj1_nested_keys = Object.keys(obj1_nested);
        const obj2_nested_keys = Object.keys(obj2_nested);

        const nestedKeys =
          obj1_nested_keys.length > obj2_nested_keys.length
            ? obj1_nested_keys
            : obj2_nested_keys;

        nestedKeys.forEach((key_nested: string) => {
          if (!_.isEqual(obj1_nested[key_nested], obj2_nested[key_nested])) {
            const errKey = `message/order.fulfillments/${i}/${key}/${key_nested}`;
            const errMsg = `Mismatch occurred while comparing '${obj1.type}' fulfillment object with ${apiSeq} on key '${key}/${key_nested}'`;
            errors.push({ errKey, errMsg });
          }
        });
      } else {
        const errKey = `message/order.fulfillments/${i}/${key}`;
        const errMsg = `Mismatch occurred while comparing '${obj1.type}' fulfillment object with ${apiSeq} on key '${key}'`;
        errors.push({ errKey, errMsg });
      }
    }
  });

  return errors;
}
function isValidTimestamp(timestamp: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(timestamp);
}

export const tagFinder = (item: { tags: any[] }, value: string): any => {
  const res = item?.tags?.find((tag: any) => {
    return (
      tag.code === "type" &&
      tag.list &&
      tag.list.find((listItem: any) => {
        return listItem.code === "type" && listItem.value == value;
      })
    );
  });
  return res;
};

export const checkQuoteTrail = (
  quoteTrailItems: any[],
  results: any,
  selectPriceMap: any,
  itemSet: any
) => {
  try {
    for (const item of quoteTrailItems) {
      let value = null;
      let itemValue = null;
      let itemID = null;
      let type = null;
      for (const val of item.list) {
        if (val.code === "id") {
          itemID = val.value;
          value = selectPriceMap.get(val.value);
        } else if (val.code === "value") {
          itemValue = Math.abs(parseFloat(val.value));
        } else if (val.code === "type") {
          type = val.value;
        }
      }

      // if (value && itemValue && value !== itemValue && type === "item") {
      //   results.push({
      //     valid: false,
      //     code: 20006,
      //     description: `Price mismatch for  [${itemID}] provided in quote object '[${value}]'. Should be same as in quote of ${constants.ON_SELECT}`,
      //   });
      // }

      if (!itemSet.has(itemID) && type === "item") {
        results.push({
          valid: false,
          code: 20006,
          description: `Invalid Item ID,  [${itemID}] not present in items array`,
        });
      }
    }
  } catch (error: any) {
    console.error(error);
  }
};

export const mapCancellationID = (
  cancelled_by: string,
  reason_id: string,
  results: any
) => {
  console.info(`Mapping cancellationID with valid ReasonID`);
  if (
    reason_id in reasonCodes &&
    reasonCodes[reason_id].USED_BY.includes(cancelled_by)
  ) {
    console.info(
      `CancellationID ${reason_id} mapped with valid ReasonID for ${cancelled_by}`
    );
    return true;
  } else {
    
    console.error(
      `Invalid CancellationID ${reason_id} or not allowed for ${cancelled_by}`
    );
    results.push({
      valid: false,
      code: 22502,
      description: `Invalid CancellationID ${reason_id} or not allowed for ${cancelled_by}`,
    });
    return false;
  }
};

export const checkQuoteTrailSum = (
  fulfillmentArr: any[],
  price: number,
  priceAtConfirm: number,
  results: any[],
  apiSeq: string
) => {
  let quoteTrailSum = 0;
  const arrType = ["misc", "packing", "delivery", "tax", "item"];

  for (const obj of fulfillmentArr) {
    const quoteTrailItems = _.filter(obj.tags, { code: "quote_trail" });
    for (const item of quoteTrailItems) {
      for (const val of item.list) {
        if (val.code === "type") {
          if (!arrType.includes(val.value)) {
            results.push({
              valid: false,
              code: 20006,
              description: `Invalid Quote Trail Type '${val.value}' in ${apiSeq}. It should be one of: 'misc', 'packing', 'delivery', 'tax', or 'item'`,
            });
          }
        }
        if (val.code === "value") {
          const value = Number(val.value);
          if (isNaN(value)) {
            results.push({
              valid: false,
              code: 20006,
              description: `Invalid Quote Trail value '${val.value}' in ${apiSeq}. It must be a valid number`,
            });
          } else {
            quoteTrailSum -= value;
          }
        }
      }
    }
  }

  quoteTrailSum = Math.abs(Number(quoteTrailSum.toFixed(2)));
  const totalPrice = Number((price + quoteTrailSum).toFixed(2));
  const confirmPrice = Number(priceAtConfirm.toFixed(2));
  console.log("12345", price, quoteTrailSum, confirmPrice);

  // if (totalPrice !== confirmPrice) {
  //   const description = `quote_trail price and item quote price sum (${totalPrice}) for ${apiSeq} should equal the price in ${constants.ON_CONFIRM} (${confirmPrice})`;
  //   results.push({
  //     valid: false,
  //     code: 22503,
  //     description,
  //   });
  //   console.error(description);
  // }
};

export const createAuthorizationHeader = async (payload: any) => {
  try {
    const header = await createAuthHeader({
      body: payload,
      privateKey: process.env.SIGN_PRIVATE_KEY!,
      subscriberId: process.env.SUBSCRIBER_ID!,
      subscriberUniqueKeyId: process.env.UKID!,
    });
    return header;
  } catch (error: any) {
    console.error("createAuthorizationHeader - Error", error);
    throw new Error(`createAuthorizationHeader - Error ${error.message}`);
  }
};

export async function lookupSubscriber(
  authorization: string,
  subscriber_id: string,
  type: string
) {
  try {
    const response = await axios.post(
      "https://preprod.registry.ondc.org/v2.0/lookup",
      JSON.stringify({
        type,
        subscriber_id,
      }),
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: authorization,
        },
      }
    );

    return response.data;
  } catch (error: any) {
    console.error("Lookup API error:", error?.response?.data || error.message);
    throw error;
  }
}
export function isPresentInRedisSet(set1: any, obj: any) {
  try {
    let exists = false;
    for (const item of set1) {
      if (JSON.stringify(item) === JSON.stringify(obj)) {
        exists = true;
        break;
      }
    }
    return exists;
  } catch (err: any) {
    console.error("Error in isPresentInRedisSet:", err);
  }
}
export const payment_status = (payment: any, flow: string) => {
  const errorObj: any = {};
  if (flow === FLOW.FLOW2A && payment.status === PAYMENT_STATUS.PAID) {
    errorObj.message = `Cannot be ${payment.status} for ${FLOW.FLOW2A} flow (Cash on Delivery)`;
    return errorObj;
  }
  if (payment.status === PAYMENT_STATUS.PAID) {
    if (!payment.params.transaction_id) {
      return false;
    }
  }

  return true;
};
export const setRedisValue = async (
  key: string,
  value: any,
  ttlInSeconds: number = TTL_IN_SECONDS
): Promise<boolean> => {
  try {
    await RedisService.setKey(key, JSON.stringify(value), ttlInSeconds);
    return true;
  } catch (err) {
    console.error(`Failed to set key '${key}':`, err);
    return false;
  }
};

export const getRedisValue = async (key: string): Promise<any | null> => {
  try {
    const data = await RedisService.getKey(key);
    return data ? JSON.parse(data) : null;
  } catch (err) {
    console.error(`Failed to get key '${key}':`, err);
    return null;
  }
};