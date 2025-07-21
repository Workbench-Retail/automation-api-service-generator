import { RedisService } from "ondc-automation-cache-lib";
import { addActionToRedisSet, taxNotInlcusive } from "../utils/helper";
import {
    checkBppIdOrBapId,
    checkContext,
    findItemByItemType,
    isObjectEmpty,
    isoDurToSec,
    timeDiff,
} from "../utils/helper";
import _ from "lodash";
import constants, {
    ApiSequence,
    ffCategory,
} from "../utils/constants";

interface BreakupElement {
    "@ondc/org/title_type": string;
    item?: {
        quantity: any;
    };
}

const retailPymntTtl: { [key: string]: string } = {
    "delivery charges": "delivery",
    "packing charges": "packing",
    tax: "tax",
    discount: "discount",
    "convenience fee": "misc",
    offer: "offer",
};

const onSelect = async (data: any) => {
    const { message, context } = data;
    const TTL_IN_SECONDS: number = Number(process.env.TTL_IN_SECONDS) || 3600;
    const { transaction_id } = context;

    if (!data || isObjectEmpty(data)) {
        return [
            {
                valid: false,
                code: 20000,
                description: "JSON cannot be empty",
            },
        ];
    }

    if (
        !message ||
        !context ||
        !message.order ||
        isObjectEmpty(message) ||
        isObjectEmpty(message.order)
    ) {
        return [
            {
                valid: false,
                code: 20000,
                description:
                    "/context, /message, /order or /message/order is missing or empty",
            },
        ];
    }

    const contextRes: any = checkContext(context, constants.ON_SELECT);
    const result: any[] = [];


    const checkBap = checkBppIdOrBapId(context.bap_id);
    const checkBpp = checkBppIdOrBapId(context.bpp_id);

    try {
        console.info(
            `Comparing Message Ids of /${constants.SELECT} and /${constants.ON_SELECT}`
        );

        const selectMsgId = await RedisService.getKey(
            `${transaction_id}_${ApiSequence.SELECT}_msgId`
        );

        if (!_.isEqual(selectMsgId, context.message_id)) {
            result.push({
                valid: false,
                code: 20000,
                description: `Message Ids for /${constants.SELECT} and /${constants.ON_SELECT} api should be same`,
            });
        }
    } catch (error: any) {
        console.error(
            `!!Error while checking message id for /${constants.ON_SELECT}, ${error.stack}`
        );
    }

    if (checkBap) {
        result.push({
            valid: false,
            code: 20000,
            description: "context/bap_id should not be a url",
        });
    }
    if (checkBpp) {
        result.push({
            valid: false,
            code: 20000,
            description: "context/bpp_id should not be a url",
        });
    }

    if (!contextRes?.valid) {
        contextRes.ERRORS.forEach((error: any) => {
            result.push({
                valid: false,
                code: 20000,
                description: error,
            });
        });
    }

    const searchContextRaw = await RedisService.getKey(
        `${transaction_id}_${ApiSequence.SEARCH}_context`
    );
    const searchContext = searchContextRaw ? JSON.parse(searchContextRaw) : null;
    const searchMessageRaw = await RedisService.getKey(
        `${transaction_id}_${ApiSequence.ON_SEARCH}_message`
    );
    const searchMessage = searchMessageRaw ? JSON.parse(searchMessageRaw) : null;

    try {
        console.info(
            `Comparing city of /${constants.SEARCH} and /${constants.ON_SELECT}`
        );
        if (!_.isEqual(searchContext.city, context.city)) {
            result.push({
                valid: false,
                code: 20000,
                description: `City code mismatch in /${constants.SEARCH} and /${constants.ON_SELECT}`,
            });
        }
    } catch (error: any) {
        console.error(
            `!!Error while comparing city in /${constants.SEARCH} and /${constants.ON_SELECT}, ${error.stack}`
        );
    }

    try {
        console.info(
            `Comparing timestamp of /${constants.SELECT} and /${constants.ON_SELECT}`
        );
        const tmpstmpRaw = await RedisService.getKey(
            `${transaction_id}_${ApiSequence.SELECT}_tmpstmp`
        );
        const tmpstmp = tmpstmpRaw ? JSON.parse(tmpstmpRaw) : null;

        console.log("timstamp", tmpstmp, context.timestamp);

        if (_.gte(tmpstmp, context.timestamp)) {
            result.push({
                valid: false,
                code: 20000,
                description: `Timestamp for /${constants.SELECT} api cannot be greater than or equal to /${constants.ON_SELECT} api`,
            });
        } else {
            const timeDifference = timeDiff(context.timestamp, tmpstmp);
            console.info(timeDifference);
            if (timeDifference > 5000) {
                result.push({
                    valid: false,
                    code: 20000,
                    description: `context/timestamp difference between /${constants.ON_SELECT} and /${constants.SELECT} should be less than 5 sec`,
                });
            }
        }
        await RedisService.setKey(
            `${transaction_id}_${ApiSequence.ON_SELECT}_tmpstmp`,
            JSON.stringify(context.timestamp),
            TTL_IN_SECONDS
        );
    } catch (error: any) {
        console.error(
            `!!Error while comparing timestamp for /${constants.SELECT} and /${constants.ON_SELECT}, ${error.stack}`
        );
    }

    try {
        const itemsOnSelectRaw = await RedisService.getKey(
            `${transaction_id}_SelectItemList`
        );

        const itemsOnSelect = itemsOnSelectRaw
            ? JSON.parse(itemsOnSelectRaw)
            : null;

        console.log("itemsOnSelect", itemsOnSelectRaw, itemsOnSelect);
        const itemsList = message.order.items;
        const selectItems: any = [];
        itemsList.forEach((item: any, index: number) => {
            if (!itemsOnSelect?.includes(item.id)) {
                result.push({
                    valid: false,
                    code: 20000,
                    description: `Invalid Item Id provided in /${constants.ON_SELECT}: ${item.id}`,
                });
            } else {
                selectItems.push(item.id);
            }
        });
        await RedisService.setKey(
            `${transaction_id}_SelectItemList`,
            JSON.stringify(selectItems),
            TTL_IN_SECONDS
        );
    } catch (error: any) {
        console.error(
            `Error while checking for item IDs for /${constants.ON_SELECT}, ${error.stack}`
        );
    }

    try {
        const fulfillments = message.order.fulfillments;
        const selectFlflmntSet: any = [];
        const fulfillment_tat_obj: any = {};
        fulfillments.forEach((flflmnt: any) => {
            fulfillment_tat_obj[flflmnt.id] = isoDurToSec(flflmnt["@ondc/org/TAT"]);
            selectFlflmntSet.push(flflmnt.id);
        });
        await RedisService.setKey(
            `${transaction_id}_selectFlflmntSet`,
            JSON.stringify(selectFlflmntSet),
            TTL_IN_SECONDS
        );
        await RedisService.setKey(
            `${transaction_id}_fulfillment_tat_obj`,
            JSON.stringify(fulfillment_tat_obj),
            TTL_IN_SECONDS
        );
    } catch (error: any) {
        console.error(
            `Error while checking for fulfillment IDs for /${constants.ON_SELECT}`,
            error.stack
        );
    }

    let on_select_error: any = {};
    try {
        console.info(`Checking domain-error in /${constants.ON_SELECT}`);
        if (data.hasOwnProperty("error")) {
            on_select_error = data.error;
        }
    } catch (error: any) {
        console.info(
            `Error while checking domain-error in /${constants.ON_SELECT}, ${error.stack}`
        );
    }

    const on_select: any = message.order;
    const itemFlfllmnts: any = {};

    try {
        console.info(
            `Checking provider id in /${constants.ON_SEARCH} and /${constants.ON_SELECT}`
        );
        const providerIdRaw = await RedisService.getKey(
            `${transaction_id}_providerId`
        );
        const providerId = providerIdRaw ? JSON.parse(providerIdRaw) : null;
        const providerLocRaw = await RedisService.getKey(
            `${transaction_id}_providerLoc`
        );
        const providerLoc = providerLocRaw ? JSON.parse(providerLocRaw) : null;
        if (providerId != on_select.provider.id) {
            result.push({
                valid: false,
                code: 20000,
                description: `provider.id mismatches in /${constants.SELECT} and /${constants.ON_SELECT}`,
            });
        }
        if (!on_select.provider.locations) {
            result.push({
                valid: false,
                code: 20000,
                description: `provider.locations[0].id is missing in /${constants.ON_SELECT}`,
            });
        } else if (on_select.provider.locations[0].id != providerLoc) {
            result.push({
                valid: false,
                code: 20000,
                description: `provider.locations[0].id mismatches in /${constants.SELECT} and /${constants.ON_SELECT}`,
            });
        }
    } catch (error: any) {
        console.error(
            `Error while comparing provider ids in /${constants.ON_SEARCH} and /${constants.ON_SELECT}, ${error.stack}`
        );
    }

    try {
        console.info(`Item Id and Fulfillment Id Mapping in /on_select`);
        let i = 0;
        const len = on_select.items.length;
        while (i < len) {
            const found = on_select.fulfillments.some(
                (fId: { id: any }) => fId.id === on_select.items[i].fulfillment_id
            );
            if (!found) {
                result.push({
                    valid: false,
                    code: 20000,
                    description: `fulfillment_id for item ${on_select.items[i].id} does not exist in order.fulfillments[]`,
                });
            }
            i++;
        }
    } catch (error: any) {
        console.error(
            `!!Error while checking Item Id and Fulfillment Id Mapping in /${constants.ON_SELECT}, ${error.stack}`
        );
    }

    try {
        console.info("Mapping and storing item Id and fulfillment Id");
        let i = 0;
        const len = on_select.items.length;
        while (i < len) {
            const id = on_select.items[i].id;
            itemFlfllmnts[id] = on_select.items[i].fulfillment_id;
            i++;
        }
        await RedisService.setKey(
            `${transaction_id}_itemFlfllmnts`,
            JSON.stringify(itemFlfllmnts),
            TTL_IN_SECONDS
        );
    } catch (error: any) {
        console.error(
            `!!Error occurred while mapping and storing item Id and fulfillment Id, ${error.stack}`
        );
    }

    try {
        console.info(`Checking TAT and TTS in /${constants.ON_SELECT}`);
        const ttsRaw = await RedisService.getKey(`${transaction_id}_timeToShip`);
        const tts = ttsRaw ? JSON.parse(ttsRaw) : null;
        on_select.fulfillments.forEach((ff: { [x: string]: any }, indx: any) => {
            const tat = isoDurToSec(ff["@ondc/org/TAT"]);
            if (tat < tts) {
                result.push({
                    valid: false,
                    code: 20000,
                    description: `/fulfillments[${indx}]/@ondc/org/TAT (O2D) in /${constants.ON_SELECT} can't be less than @ondc/org/time_to_ship (O2S) in /${constants.ON_SEARCH}`,
                });
            }
            if (tat === tts) {
                result.push({
                    valid: false,
                    code: 20000,
                    description: `/fulfillments[${indx}]/@ondc/org/TAT (O2D) in /${constants.ON_SELECT} can't be equal to @ondc/org/time_to_ship (O2S) in /${constants.ON_SEARCH}`,
                });
            }
            console.info(tat, "asdfasdf", tts);
        });
    } catch (error: any) {
        console.error(
            `!!Error while checking TAT and TTS in /${constants.ON_SELECT}`
        );
    }

    try {
        console.info(
            `Checking TAT and TTS in /${constants.ON_SELECT} and /${constants.ON_SEARCH}`
        );
        const catalog = searchMessage.catalog;
        const providers = catalog["bpp/providers"];
        let max_time_to_ships: any = [];
        for (
            let providerIndex = 0;
            providerIndex < providers.length;
            providerIndex++
        ) {
            const providerItems = providers[providerIndex].items;
            for (let itemIndex = 0; itemIndex < providerItems.length; itemIndex++) {
                const timeToShip = isoDurToSec(
                    providerItems[itemIndex]["@ondc/org/time_to_ship"]
                );
                if (timeToShip) {
                    max_time_to_ships.push(timeToShip);
                }
            }
        }
        const max_tts = max_time_to_ships.sort((a : any, b: any) => a - b)[0];
        const on_select_tat = on_select.fulfillments.map((e: any) =>
            isoDurToSec(e["@ondc/org/TAT"])
        );
        if (on_select_tat < max_tts) {
            result.push({
                valid: false,
                code: 20000,
                description: `/fulfillments/@ondc/org/TAT (O2D) in /${constants.ON_SELECT} can't be less than @ondc/org/time_ship (O2S) in /${constants.ON_SEARCH}`,
            });
        }
        if (on_select_tat === max_tts) {
            result.push({
                valid: false,
                code: 20000,
                description: `/fulfillments/@ondc/org/TAT (O2D) in /${constants.ON_SELECT} can't be equal to @ondc/org/time_ship (O2S) in /${constants.ON_SEARCH}`,
            });
        }
    } catch (error: any) {
        console.error(
            `!!Error while Checking TAT and TTS in /${constants.ON_SELECT} and /${constants.ON_SEARCH}`
        );
    }

    let nonServiceableFlag = 0;
    try {
        console.info(`Checking fulfillments' state in ${constants.ON_SELECT}`);
        const ffState = on_select.fulfillments.every(
            (ff: { state: { descriptor: any } }) => {
                if (ff.state) {
                    const ffDesc = ff.state.descriptor;
                    if (ffDesc.code === "Non-serviceable") {
                        nonServiceableFlag = 1;
                    }
                    return ffDesc.hasOwnProperty("code")
                        ? ffDesc.code === "Serviceable" || ffDesc.code === "Non-serviceable"
                        : false;
                }
                return;
            }
        );
        if (!ffState) {
            result.push({
                valid: false,
                code: 20000,
                description: `Pre-order fulfillment state codes should be used in fulfillments[].state.descriptor.code`,
            });
        } else if (
            nonServiceableFlag &&
            (!on_select_error ||
                !(
                    on_select_error.type === "DOMAIN-ERROR" &&
                    on_select_error.code === "30009"
                ))
        ) {
            result.push({
                valid: false,
                code: 20000,
                description: `Non Serviceable Domain error should be provided when fulfillment is not serviceable`,
            });
        }
    } catch (error: any) {
        console.error(
            `!!Error while checking fulfillments' state in /${constants.ON_SELECT}, ${error.stack}`
        );
    }

    try {
        console.info(`Checking fulfillments' state in ${constants.ON_SELECT}`);
        on_select.fulfillments.forEach((ff: any, idx: number) => {
            if (ff.state) {
                const ffDesc = ff.state.descriptor;
                function checkFFOrgCategory(selfPickupOrDelivery: number) {
                    if (
                        !ff["@ondc/org/category"] ||
                        !ffCategory[selfPickupOrDelivery].includes(ff["@ondc/org/category"])
                    ) {
                        result.push({
                            valid: false,
                            code: 20000,
                            description: `In Fulfillment${idx}, @ondc/org/category is not a valid value in ${constants.ON_SELECT
                                } and should have one of these values ${[
                                    ffCategory[selfPickupOrDelivery],
                                ]}`,
                        });
                    }
                    const domain = data.context.domain.split(":")[1];
                    if (
                        ff.type === "Delivery" &&
                        domain === "RET11" &&
                        ff["@ondc/org/category"] !== "Immediate Delivery"
                    ) {
                        result.push({
                            valid: false,
                            code: 20000,
                            description: `In Fulfillment${idx}, @ondc/org/category should be "Immediate Delivery" for F&B in ${constants.ON_SELECT}`,
                        });
                    }
                }
                if (ffDesc.code === "Serviceable" && ff.type == "Delivery") {
                    checkFFOrgCategory(0);
                } else if (ff.type == "Self-Pickup") {
                    checkFFOrgCategory(1);
                }
            } else {
                result.push({
                    valid: false,
                    code: 20000,
                    description: `In Fulfillment${idx}, descriptor code is mandatory in ${constants.ON_SELECT}`,
                });
            }
        });
    } catch (error: any) {
        console.error(
            `!!Error while checking fulfillments @ondc/org/category in /${constants.ON_SELECT}, ${error.stack}`
        );
    }

    let onSelectPrice: any = 0;
    let onSelectItemsPrice = 0;

    try {
        const itemPrices = new Map();
        on_select.quote.breakup.forEach(
            (item: { [x: string]: any; price: { value: any } }) => {
                if (
                    item["@ondc/org/item_id"] &&
                    item.price &&
                    item.price.value &&
                    item["@ondc/org/title_type"] === "item"
                ) {
                    itemPrices.set(item["@ondc/org/item_id"], Math.abs(item.price.value));
                }
            }
        );
        await RedisService.setKey(
            `${transaction_id}_selectPriceMap`,
            JSON.stringify(Array.from(itemPrices.entries())),
            TTL_IN_SECONDS
        );
    } catch (error: any) {
        console.error(
            `!!Error while checking and comparing the quoted price in /${constants.ON_SELECT}, ${error.stack}`
        );
    }

    try {
        console.info(
            `-x-x-x-x-Quote Breakup ${constants.ON_SELECT} all checks-x-x-x-x`
        );
        const itemsIdListRaw = await RedisService.getKey(
            `${transaction_id}_itemsIdList`
        );
        const itemsIdList = itemsIdListRaw ? JSON.parse(itemsIdListRaw) : null;
        const itemsCtgrsRaw = await RedisService.getKey(
            `${transaction_id}_itemsCtgrs`
        );
        const itemsCtgrs = itemsCtgrsRaw ? JSON.parse(itemsCtgrsRaw) : null;
        if (on_select.quote) {
            on_select.quote.breakup.forEach((element: any, i: any) => {
                const titleType = element["@ondc/org/title_type"];
                console.info(
                    `Calculating quoted Price Breakup for element ${element.title}`
                );
                onSelectPrice += parseFloat(element.price.value);
                if (titleType === "item") {
                    if (!(element["@ondc/org/item_id"] in itemFlfllmnts)) {
                        result.push({
                            valid: false,
                            code: 20000,
                            description: `item with id: ${element["@ondc/org/item_id"]} in quote.breakup[${i}] does not exist in items[]`,
                        });
                    }
                    console.info(
                        `Comparing individual item's total price and unit price `
                    );
                    if (!element.hasOwnProperty("item")) {
                        result.push({
                            valid: false,
                            code: 20000,
                            description: `Item's unit price missing in quote.breakup for item id ${element["@ondc/org/item_id"]}`,
                        });
                    } else if (
                        parseFloat(element.item.price.value) *
                        element["@ondc/org/item_quantity"].count !=
                        element.price.value
                    ) {
                        result.push({
                            valid: false,
                            code: 20000,
                            description: `Item's unit and total price mismatch for id: ${element["@ondc/org/item_id"]}`,
                        });
                    }
                }
                console.info(`Calculating Items' prices in /${constants.ON_SELECT}`);
                if (
                    typeof itemsIdList === "object" &&
                    itemsIdList &&
                    element["@ondc/org/item_id"] in itemsIdList
                ) {
                    if (
                        titleType === "item" ||
                        (titleType === "tax" &&
                            !taxNotInlcusive.includes(
                                itemsCtgrs[element["@ondc/org/item_id"]]
                            ))
                    ) {
                        onSelectItemsPrice += parseFloat(element.price.value);
                    }
                }
                if (titleType === "tax" || titleType === "discount") {
                    if (!(element["@ondc/org/item_id"] in itemFlfllmnts)) {
                        result.push({
                            valid: false,
                            code: 20000,
                            description: `item with id: ${element["@ondc/org/item_id"]} in quote.breakup[${i}] does not exist in items[] (should be a valid item id)`,
                        });
                    }
                }
                if (
                    titleType === "packing" ||
                    titleType === "delivery" ||
                    titleType === "misc"
                ) {
                    if (
                        !Object.values(itemFlfllmnts).includes(element["@ondc/org/item_id"])
                    ) {
                        result.push({
                            valid: false,
                            code: 20000,
                            description: `invalid  id: ${element["@ondc/org/item_id"]} in ${titleType} line item (should be a valid fulfillment_id as provided in message.items for the items)`,
                        });
                    }
                }
            });
            await RedisService.setKey(
                `${transaction_id}_onSelectPrice`,
                JSON.stringify(on_select.quote.price.value),
                TTL_IN_SECONDS
            );
            onSelectPrice = onSelectPrice.toFixed(2);
            console.info(
                `Matching quoted Price ${parseFloat(
                    on_select.quote.price.value
                )} with Breakup Price ${onSelectPrice}`
            );
            if (
                Math.round(onSelectPrice) !=
                Math.round(parseFloat(on_select.quote.price.value))
            ) {
                result.push({
                    valid: false,
                    code: 20000,
                    description: `quote.price.value ${on_select.quote.price.value} does not match with the price breakup ${onSelectPrice}`,
                });
            }
            const selectedPriceRaw = await RedisService.getKey(
                `${transaction_id}_selectedPrice`
            );
            const selectedPrice = selectedPriceRaw
                ? JSON.parse(selectedPriceRaw)
                : null;
            console.info(
                `Matching price breakup of items ${onSelectItemsPrice} (/${constants.ON_SELECT}) with selected items price ${selectedPrice} (${constants.SELECT})`
            );
            if (selectedPrice &&
                typeof selectedPrice === "number" &&
                onSelectItemsPrice !== selectedPrice
            ) {
                result.push({
                    valid: false,
                    code: 20000,
                    description: `Warning: Quoted Price in /${constants.ON_SELECT} INR ${onSelectItemsPrice} does not match with the total price of items in /${constants.SELECT} INR ${selectedPrice} i.e price for the item mismatch in on_search and on_select`,
                });
                console.info("Quoted Price and Selected Items price mismatch");
            }
        } else {
            console.error(`Missing quote object in ${constants.ON_SELECT}`);
        }
    } catch (error: any) {
        console.error(
            `!!Error while checking and comparing the quoted price in /${constants.ON_SELECT}, ${error.stack}`
        );
    }

    try {
        console.info(
            `Checking if delivery line item present in case of Serviceable for ${constants.ON_SELECT}`
        );
        if (on_select.quote) {
            const quoteBreakup = on_select.quote.breakup;
            const deliveryItems = quoteBreakup.filter(
                (item: { [x: string]: string }) =>
                    item["@ondc/org/title_type"] === "delivery"
            );
            const noOfDeliveries = deliveryItems.length;
            if (!noOfDeliveries && !nonServiceableFlag) {
                result.push({
                    valid: false,
                    code: 20000,
                    description: `delivery line item must be present in quote/breakup (if location is serviceable)`,
                });
            }
            if (noOfDeliveries && nonServiceableFlag) {
                deliveryItems.map((e: any) => {
                    if (e.price.value > 0) {
                        console.error(
                            "Delivery charges not applicable for non-servicable locations"
                        );
                    }
                });
            }
        } else {
            console.error(`Missing quote object in ${constants.ON_SELECT}`);
        }
    } catch (error: any) {
        console.info(
            `!!Error occurred while checking delivery line item in /${constants.ON_SELECT}, ${error.stack}`
        );
    }

    try {
        console.info(
            `Checking payment breakup title & type in /${constants.ON_SELECT}`
        );
        if (on_select.quote) {
            on_select.quote.breakup.forEach(
                (item: { [x: string]: any; title: string }) => {
                    if (
                        item["@ondc/org/title_type"] != "item" &&
                        !Object.values(retailPymntTtl).includes(
                            item["@ondc/org/title_type"]
                        )
                    ) {
                        result.push({
                            valid: false,
                            code: 20000,
                            description: `Quote breakup Payment title type "${item["@ondc/org/title_type"]}" is not as per the API contract`,
                        });
                    }
                    if (
                        item["@ondc/org/title_type"] !== "item" &&
                        !(item.title.toLowerCase().trim() in retailPymntTtl)
                    ) {
                        result.push({
                            valid: false,
                            code: 20000,
                            description: `Quote breakup Payment title "${item.title}" is not as per the API Contract`,
                        });
                    } else if (
                        item["@ondc/org/title_type"] !== "item" &&
                        retailPymntTtl[item.title.toLowerCase().trim()] !==
                        item["@ondc/org/title_type"]
                    ) {
                        result.push({
                            valid: false,
                            code: 20000,
                            description: `Quote breakup Payment title "${item.title
                                }" comes under the title type "${retailPymntTtl[item.title.toLowerCase().trim()]
                                }"`,
                        });
                    }
                }
            );
        } else {
            console.error(`Missing quote object in ${constants.ON_SELECT}`);
        }
    } catch (error: any) {
        console.error(
            `!!Error while checking payment breakup title & type in /${constants.ON_SELECT}`
        );
    }

    try {
        console.info("Checking Fulfillment TAT...");
        on_select.fulfillments.forEach((ff: { [x: string]: any; id: any }) => {
            if (!ff["@ondc/org/TAT"]) {
                console.info(
                    `Fulfillment TAT must be present for Fulfillment ID: ${ff.id}`
                );
                result.push({
                    valid: false,
                    code: 20000,
                    description: `Fulfillment TAT must be present for fulfillment ID: ${ff.id}`,
                });
            }
        });
    } catch (error: any) {
        console.info(
            `Error while checking fulfillments TAT in /${constants.ON_SELECT}`
        );
    }

    try {
        console.info("Checking fulfillment.id, fulfillment.type and tracking");
        on_select.fulfillments.forEach(async (ff: any) => {
            let ffId = "";
            if (!ff.id) {
                console.info(`Fulfillment Id must be present `);
                result.push({
                    valid: false,
                    code: 20000,
                    description: `Fulfillment Id must be present`,
                });
            }
            ffId = ff.id;
            if (ffId) {
                if (ff.tracking === false || ff.tracking === true) {
                    await RedisService.setKey(
                        `${transaction_id}_${ffId}_tracking`,
                        JSON.stringify(ff.tracking),
                        TTL_IN_SECONDS
                    );
                } else {
                    console.info(
                        `Tracking must be present for fulfillment ID: ${ff.id} in boolean form`
                    );
                    result.push({
                        valid: false,
                        code: 20000,
                        description: `Tracking must be present for fulfillment ID: ${ff.id} in boolean form`,
                    });
                }
            }
        });
    } catch (error: any) {
        console.info(
            `Error while checking fulfillments id, type and tracking in /${constants.ON_SELECT}`
        );
    }

    try {
        console.info("Checking quote validity quote.ttl");
        if (!on_select.quote.hasOwnProperty("ttl")) {
            result.push({
                valid: false,
                code: 20000,
                description: "quote.ttl: Validity of the quote is missing",
            });
        }
    } catch (error: any) {
        console.error(
            `!!Error while checking quote.ttl in /${constants.ON_SELECT}`
        );
    }

    try {
        if (on_select.quote) {
            console.info(`Storing Quote object in /${constants.ON_SELECT}`);
            on_select.quote.breakup.forEach((element: BreakupElement) => {
                if (element["@ondc/org/title_type"] === "item") {
                    if (element.item && element.item.hasOwnProperty("quantity")) {
                        delete element.item.quantity;
                    }
                }
            });
            await RedisService.setKey(
                `${transaction_id}_quoteObj`,
                JSON.stringify(on_select.quote),
                TTL_IN_SECONDS
            );
        }
    } catch (error: any) {
        console.error(
            `!!Error while storing quote object in /${constants.ON_SELECT}, ${error.stack}`
        );
    }

    try {
        console.info(
            `Comparing fulfillmentID with providerID for /${constants.ON_SELECT} `
        );
        const len: number = on_select.fulfillments.length;
        let i = 0;
        while (i < len) {
            const fulfillment_id = on_select.fulfillments[i].id;
            const provider_id = on_select.provider.id;
            if (fulfillment_id === provider_id) {
                result.push({
                    valid: false,
                    code: 20000,
                    description:
                        "FullfillmentID can't be equal to ProviderID on ${constants.ON_SELECT}",
                });
            }
            i++;
        }
    } catch (error: any) {
        console.error(
            `!Error while comparing fulfillmentID with providerID in /${ApiSequence.ON_SELECT}, ${error.stack}`
        );
    }

    await RedisService.setKey(
        `${transaction_id}_quote_price`,
        JSON.stringify(on_select.quote.price.value),
        TTL_IN_SECONDS
    );

    return result;
};

export default onSelect;
