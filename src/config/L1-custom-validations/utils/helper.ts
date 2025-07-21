import _ from "lodash";
import constants, { ApiSequence, PAYMENT_STATUS } from "./constants";
import { RedisService } from "ondc-automation-cache-lib";
import { groceryCategoryMappingWithStatutory } from "./constants";
import { statutory_reqs } from "./enum";
import { data } from "./areaCodeMap";
import { InputObject } from "./interface";


type ObjectType = {
    [key: string]: string | string[]
}

interface ValidationError {
    valid: boolean;
    code: number;
    description: string;
}

type ValidationOutput = ValidationError[];

const TTL_IN_SECONDS = 3000;

const getDecimalPrecision = (numberString: string) => {
    const parts = numberString.trim().split(".");
    return parts.length === 2 ? parts[1].length : 0;
};

export const isObjectEmpty = (obj: any) => {
    return Object.keys(obj).length === 0;
};

export function validateObjectString(obj: ObjectType): string | null {
    const errors: string[] = []

    Object.entries(obj).forEach(([key, value]) => {
        if (typeof value === 'string' && value.trim() === '') {
            errors.push(`'${key}'`)
        } else if (Array.isArray(value) && value.some((v) => typeof v === 'string' && v.trim() === '')) {
            errors.push(`'${key}'`)
        }
    })

    if (errors.length > 0) {
        return `${errors.join(', ')} cannot be empty`
    }

    return null
}

export const hasProperty = (object: any, propetyName: string) => {
    return Object.prototype.hasOwnProperty.call(object, propetyName);
};

export const checkTagConditions = async (
    message: any,
    context: any,
    apiSeq: string
) => {
    const TTL_IN_SECONDS = 3000;
    const tags: any = [];

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

        msgMap[messageId] = action;
        await RedisService.setKey(key, JSON.stringify(msgMap), TTL_IN_SECONDS);
        return true;
    } catch (error: any) {
        console.error(`Error in addMsgIdToRedisSet: ${error.stack}`);
        throw error;
    }
};

export const addFulfillmentIdToRedisSet = async (
    transactionId: string,
    fulfillment_id: string
) => {
    try {
        const key = `${transactionId}_msgId_set`;
        let existingSet: string[] = [];

        const existing = await RedisService.getKey(key);
        if (existing) {
            existingSet = JSON.parse(existing);
        }

        if (!existingSet.includes(fulfillment_id)) {
            existingSet.push(fulfillment_id);
            await RedisService.setKey(
                key,
                JSON.stringify(existingSet),
                TTL_IN_SECONDS
            );

            return false;
        }
        return true;
    } catch (error: any) {
        console.error(`Error in addFulfillmentIdToRedisSet: ${error.stack}`);
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
        let attributeTag: any = null;
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
                        `Invalid attribute for item with category id: ${missingMandatoryTags.join(", ")}`;
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
    return Uri.includes(id)
}


export function validateBapUri(
    bapUri: string,
    bapId: string,
    result: ValidationOutput,
    addError: (code: number, description: string) => void
): void {
    if (!checkIdInUri(bapUri, bapId)) {
        addError(20006, `Bap_id ${bapId} is not found in BapUri ${bapUri}`);
    }
}

export function validateBppUri(
    bppUri: string,
    bppId: string,
    result: ValidationOutput,
    addError: (code: number, description: string) => void
): void {
    if (!checkIdInUri(bppUri, bppId)) {
        addError(20006, `Bpp_id ${bppId} is not found in BppUri ${bppUri}`);
    }
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
        const expectedPrecision = constants.DECIMAL_PRECISION;

        return latPrecision === expectedPrecision &&
            longPrecision === expectedPrecision
            ? 1
            : { latPrecision, longPrecision };
    } catch (error) {
        console.error(error);
        return error;
    }
};


export function findItemByItemType(item: any) {
    const tags = item.tags
    if (tags) {
        for (let j = 0; j < tags.length; j++) {
            if (
                tags[j].code === 'type' &&
                tags[j].list &&
                tags[j].list.length === 1 &&
                tags[j].list[0].code === 'type' &&
                tags[j].list[0].value === 'item'
            ) {
                return item
            }
        }
    }
}

export const isoDurToSec = (duration: string) => {
    const durRE = /P((\d+)Y)?((\d+)M)?((\d+)W)?((\d+)D)?T?((\d+)H)?((\d+)M)?((\d+)S)?/

    const splitTime = durRE.exec(duration)
    if (!splitTime) {
        return 0
    }

    const years = Number(splitTime?.[2]) || 0
    const months = Number(splitTime?.[4]) || 0
    const weeks = Number(splitTime?.[6]) || 0
    const days = Number(splitTime?.[8]) || 0
    const hours = Number(splitTime?.[10]) || 0
    const minutes = Number(splitTime?.[12]) || 0
    const seconds = Number(splitTime?.[14]) || 0

    const result =
        years * 31536000 + months * 2628288 + weeks * 604800 + days * 86400 + hours * 3600 + minutes * 60 + seconds

    return result
}

export const fnbCategories = [
    'Baklava',
    'Bao',
    'Barbecue',
    'Biryani',
    'Bread',
    'Burger',
    'Cakes',
    'Chaat',
    'Cheesecakes',
    'Chicken',
    'Chicken wings',
    'Chips',
    'Coffee',
    'Cookies',
    'Crepes',
    'Dal',
    'Desserts',
    'Dhokla',
    'Dosa',
    'Doughnuts',
    'Eggs',
    'Energy Drinks',
    'Falafel',
    'Fresh Juice',
    'Fries',
    'Ice cream',
    'Idli',
    'Kabab',
    'Kachori',
    'Kulfi',
    'Lassi',
    'Meal bowl',
    'Mezze',
    'Mithai',
    'Momos',
    'Mutton',
    'Nachos',
    'Noodles',
    'Pakodas',
    'Pancakes',
    'Paneer',
    'Pasta',
    'Pastries',
    'Pie',
    'Pizza',
    'Poha',
    'Raita',
    'Rice',
    'Rolls',
    'Roti',
    'Salad',
    'Samosa',
    'Sandwich',
    'Seafood',
    'Shakes & Smoothies',
    'Soft Drink',
    'Soup',
    'Spring Roll',
    'Sushi',
    'Tacos',
    'Tandoori',
    'Tart',
    'Tea',
    'Thali',
    'Tikka',
    'Upma',
    'Uttapam',
    'Vada',
    'Vegetables',
    'Waffle',
    'Wrap',
    'Yogurt',
    'F&B',
]
export const taxNotInlcusive = [...fnbCategories]

export const timeDiff = (time1: any, time2: any) => {
    const dtime1: any = new Date(time1)
    const dtime2: any = new Date(time2)

    if (isNaN(dtime1 - dtime2)) return 0
    else return dtime1 - dtime2
}
export function checkItemTag(item: any, itemArray: any[]) {
    if (item.tags) {
        for (const tag of item.tags) {
            if (tag.code === 'parent') {
                for (const list of tag.list) {
                    if (list.code === 'id' && !itemArray.includes(list.value)) {
                        return true
                    }
                }
            }
        }
    }

    return false
}


export function compareObjects(obj1: any, obj2: any, parentKey?: string): string[] {
    const errors: string[] = []

    // Check if obj1 or obj2 is undefined or null
    if (obj1 === null || obj1 === undefined || obj2 === null || obj2 === undefined) {
        errors.push('One of the objects is undefined or null')
        return errors
    }

    const keys1 = Object.keys(obj1)
    const keys2 = Object.keys(obj2)

    // Check for key length mismatch
    if (keys1.length !== keys2.length) {
        errors.push(`Key length mismatch for ${parentKey || 'root'}`)
        return errors // Stop comparing if key length mismatch is detected
    }

    for (const key of keys1) {
        const fullKey = parentKey ? `${parentKey}.${key}` : key

        if (typeof obj1[key] === 'object' && typeof obj2[key] === 'object') {
            const nestedErrors = compareObjects(obj1[key], obj2[key], fullKey)
            errors.push(...nestedErrors)
        } else if (obj1[key] !== obj2[key]) {
            errors.push(`Key '${fullKey}' mismatch: ${obj1[key]} !== ${obj2[key]}`)
        }
    }

    return errors
}

export function compareQuoteObjects(obj1: InputObject, obj2: InputObject, api1: string, api2: string): string[] {
    const errors: string[] = []

    // Compare root level properties
    const rootKeys1 = Object.keys(obj1)
    const rootKeys2 = Object.keys(obj2)

    if (rootKeys1.length !== rootKeys2.length) {
        errors.push('Root level properties mismatch')
        return errors
    }

    // Compare breakup array
    obj1.breakup.forEach((item1: any) => {
        const matchingItem = obj2.breakup.find(
            (item2: any) =>
                item1['@ondc/org/item_id'] === item2['@ondc/org/item_id'] &&
                item1['@ondc/org/title_type'] === item2['@ondc/org/title_type'],
        )

        if (!matchingItem || !deepCompare(item1, matchingItem)) {
            errors.push(
                `Mismatch found for item with item_id ${item1['@ondc/org/item_id']} while comparing quote object of ${api1} and ${api2}`,
            )
        }
    })

    return errors
}

function deepCompare(obj1: any, obj2: any): boolean {
    if (typeof obj1 !== 'object' || typeof obj2 !== 'object') {
        return obj1 === obj2
    }

    const keys1 = Object.keys(obj1)
    const keys2 = Object.keys(obj2)

    if (keys1.length !== keys2.length) {
        return false
    }

    for (const key of keys1) {
        if (!keys2.includes(key) || !deepCompare(obj1[key], obj2[key])) {
            return false
        }
    }

    return true
}
export function isTagsValid(tags: any[], entity: string): boolean {
    const termsObject = tags.find((tag: { code: string }) => tag.code === entity)

    // If termsObject is found, check the list
    if (termsObject) {
        const taxNumberObject = termsObject.list.find((item: { code: string }) => item.code === 'tax_number')

        // If taxNumberObject is found, validate the value
        if (taxNumberObject) {
            const value = taxNumberObject.value

            if (typeof value === 'string' && value.length <= 15) {
                return true // Value is valid
            }
        }
    }

    return false
}
export const payment_status = (payment: any, flow: string) => {
    const errorObj: any = {}
    if ((flow === FLOW.FLOW2A) && payment.status === PAYMENT_STATUS.PAID) {
        errorObj.message = `Cannot be ${payment.status} for ${FLOW.FLOW2A} flow (Cash on Delivery)`
        return errorObj
    }
    if (payment.status === PAYMENT_STATUS.PAID) {
        if (!payment.params.transaction_id) {
            return false
        }
    }

    return true
}

export const sumQuoteBreakUp = (quote: any) => {
    const totalPrice = Number(quote.price.value)
    let currentPrice = 0
    quote.breakup.forEach((item: any) => {
        currentPrice += Number(item.price.value)
    })
    return Math.round(totalPrice) === Math.round(currentPrice)
}
export enum FLOW {
    FLOW1 = '1',
    FLOW2 = '2',
    FLOW2A = '2A',
    FLOW3 = '3',
    FLOW4 = '4',
    FLOW5 = '5',
    FLOW6 = '6',
    FLOW7 = '7',
    FLOW8 = '8',
    FLOW9 = '9'
}
export function areGSTNumbersMatching(tags1: any[], tags2: any[], termToMatch: string): boolean {
    // Find the GST number in the first tags array based on the specified term
    const gstNumber1 = findGSTNumber(tags1, termToMatch)

    // Find the GST number in the second tags array based on the specified term
    const gstNumber2 = findGSTNumber(tags2, termToMatch)

    // Check if both GST numbers are the same

    if (typeof gstNumber2 === 'string' && typeof gstNumber1 === 'string') return gstNumber1 === gstNumber2
    else return false
}

function findGSTNumber(tags: any[], termToMatch: string): string | undefined {
    // Find the object with the specified term
    try {
        const termObject = tags.find((tag) => tag.code === termToMatch)

        // If termObject is found, check the list for the GST number
        if (termObject) {
            const taxNumberObject = termObject.list.find((item: { code: string }) => item.code === 'tax_number')

            // If taxNumberObject is found, return the GST number
            if (taxNumberObject) {
                const value = taxNumberObject.value

                if (typeof value === 'string' && value.length <= 15) {
                    return value // Return the GST number
                }
            }
        }

        return undefined // GST number not found or not valid
    } catch (error: any) {
    }

    return undefined
}
export function areGSTNumbersDifferent(tags: any[]): boolean {
    // Find the "tax_number" in "bpp_terms"
    const bppTermsObject = tags.find((tag) => tag.code === 'bpp_terms')
    const bppTaxNumber = findTaxNumber(bppTermsObject)

    // Find the "tax_number" in "bap_terms"
    const bapTermsObject = tags.find((tag) => tag.code === 'bap_terms')
    const bapTaxNumber = findTaxNumber(bapTermsObject)

    // Check if both "tax_number" values are different
    if (typeof bppTaxNumber === 'string' && typeof bapTaxNumber === 'string') return bppTaxNumber === bapTaxNumber
    else return false
}

function findTaxNumber(termObject: any): string | undefined {
    if (termObject) {
        const taxNumberObject = termObject.list.find((item: { code: string }) => item.code === 'tax_number')

        if (taxNumberObject) {
            const value = taxNumberObject.value

            if (typeof value === 'string') {
                return value
            }
        }
    }

    return undefined
}
export const compareCoordinates = (coord1: any, coord2: any) => {
    if (!coord1 || !coord2) return false
    // Remove all spaces from the coordinates
    const cleanCoord1 = coord1.replace(/\s/g, '')
    const cleanCoord2 = coord2.replace(/\s/g, '')

    // Compare the cleaned coordinates
    return cleanCoord1 === cleanCoord2
}
export function compareLists(list1: any[], list2: any[]): string[] {
    const errors: string[] = []

    for (const obj1 of list1) {
        const matchingObj = list2.find((obj2) => obj2.code === obj1.code)

        if (!matchingObj) {
            if (obj1.code !== 'np_type') {
                errors.push(`Code '${obj1.code}' present in first list but not in second list.`)
            }
        } else {
            if (obj1.value !== matchingObj.value) {
                errors.push(`Code '${obj1.code}' value not matching.`)
            }
        }
    }

    return errors
}


export const addActionToRedisSet = async (
    transactionId: string,
    previousAction: string,
    presentAction: string
): Promise<boolean> => {
    try {
        const key = `${transactionId}_previousCall`;
        let existingSet: string[] = [];

        const existing = await RedisService.getKey(key);
        if (existing) {
            existingSet = JSON.parse(existing);
        }

        if (
            previousAction === presentAction ||
            (!_.isEmpty(existingSet) && existingSet.includes(previousAction))
        ) {
            existingSet.push(presentAction);
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