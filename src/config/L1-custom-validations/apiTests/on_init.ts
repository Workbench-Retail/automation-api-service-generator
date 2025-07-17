/* eslint-disable no-prototype-builtins */
import _, { isArray } from "lodash";
import { RedisService } from "ondc-automation-cache-lib";
import {
  addActionToRedisSet,
  checkBppIdOrBapId,
  checkContext,
  checkItemTag,
  compareObjects,
  compareQuoteObjects,
  isObjectEmpty,
  isTagsValid,
  payment_status,
  timeDiff as timeDifference,
} from "../utils/helper";
import constants, { ApiSequence } from "../utils/constants";

const onInit = async (data: any) => {
  const result: any[] = [];
  const TTL_IN_SECONDS: number = Number(process.env.TTL_IN_SECONDS) || 3600;
  const flow = "2";
  try {
    if (!data || isObjectEmpty(data)) {
      result.push({
        valid: false,
        code: 20000,
        description: "JSON cannot be empty",
      });
      return result;
    }

    const { message, context }: any = data;
    const { transaction_id } = context;
    if (
      !message ||
      !context ||
      !message.order ||
      isObjectEmpty(message) ||
      isObjectEmpty(message.order)
    ) {
      result.push({
        valid: false,
        code: 20000,
        description:
          "/context, /message, /order or /message/order is missing or empty",
      });
      return result;
    }

 
    const searchContextRaw = await RedisService.getKey(
      `${transaction_id}_${ApiSequence.SEARCH}_context`
    );
    const searchContext = searchContextRaw
      ? JSON.parse(searchContextRaw)
      : null;
    const contextRes: any = checkContext(context, constants.ON_INIT);
    const parentItemIdSetRaw = await RedisService.getKey(
      `${transaction_id}_parentItemIdSet`
    );
    const parentItemIdSet = parentItemIdSetRaw
      ? JSON.parse(parentItemIdSetRaw)
      : null;
    const select_customIdArrayRaw = await RedisService.getKey(
      `${transaction_id}_select_customIdArray`
    );
    const select_customIdArray = select_customIdArrayRaw
      ? JSON.parse(select_customIdArrayRaw)
      : null;

    const checkBap = checkBppIdOrBapId(context.bap_id);
    const checkBpp = checkBppIdOrBapId(context.bpp_id);

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
    const domain = await RedisService.getKey(`${transaction_id}_domain`);

    console.log("domain", domain, data.context.domain.split(":")[1]);
    if (!_.isEqual(data.context.domain.split(":")[1], domain)) {
      result.push({
        valid: false,
        code: 20000,
        description: `Domain should be same in each action`,
      });
    }

    await RedisService.setKey(
      `${transaction_id}_${ApiSequence.ON_INIT}`,
      JSON.stringify(data),
      TTL_IN_SECONDS
    );
    console.info(`Checking context for /${constants.ON_INIT} API`);
    try {
      const res: any = checkContext(context, constants.ON_INIT);
      if (!res.valid) {
        res.ERRORS.forEach((error: any) => {
          result.push({
            valid: false,
            code: 20000,
            description: error,
          });
        });
      }
    } catch (error: any) {
      console.error(
        `!!Some error occurred while checking /${constants.ON_INIT} context, ${error.stack}`
      );
    }

    try {
      console.info(
        `Comparing city of ${constants.SEARCH} & ${constants.ON_INIT}`
      );
      if (!_.isEqual(searchContext.city, context.city)) {
        result.push({
          valid: false,
          code: 20000,
          description: `City code mismatch in ${constants.SEARCH} & ${constants.ON_INIT}`,
        });
      }
    } catch (error: any) {
      console.info(
        `Error while comparing city in ${constants.SEARCH} & ${constants.ON_INIT}, ${error.stack}`
      );
    }

    try {
      console.info(
        `Comparing timestamp of ${constants.INIT} & ${constants.ON_INIT}`
      );
      const tmpstmpRaw = await RedisService.getKey(
        `${transaction_id}_${ApiSequence.INIT}_tmpstmp`
      );
      const tmpstmp = tmpstmpRaw ? JSON.parse(tmpstmpRaw) : null;
      if (_.gt(tmpstmp, context.timestamp)) {
        result.push({
          valid: false,
          code: 20000,
          description: `Timestamp for ${constants.INIT} api cannot be greater than or equal to ${constants.ON_INIT} api`,
        });
      } else {
        const timeDiff = timeDifference(context.timestamp, tmpstmp);
        console.info(timeDiff);
        if (timeDiff > 5000) {
          result.push({
            valid: false,
            code: 20000,
            description: `context/timestamp difference between /${constants.ON_INIT} and /${constants.INIT} should be less than 5 sec`,
          });
        }
      }

      await RedisService.setKey(
        `${transaction_id}_${ApiSequence.ON_INIT}_tmpstmp`,
        JSON.stringify(context.timestamp),
        TTL_IN_SECONDS
      );
    } catch (error: any) {
      console.error(
        `!!Error while comparing timestamp for /${constants.INIT} and /${constants.ON_INIT} api, ${error.stack}`
      );
    }

    try {
      console.info(
        `Comparing Message Ids of /${constants.INIT} and /${constants.ON_INIT}`
      );
      const msgIdRaw = await RedisService.getKey(
        `${transaction_id}_${ApiSequence.INIT}_msgId`
      );
      const msgId = msgIdRaw ? JSON.parse(msgIdRaw) : null;
      if (!_.isEqual(msgId, context.message_id)) {
        result.push({
          valid: false,
          code: 20000,
          description: `Message Ids for /${constants.INIT} and /${constants.ON_INIT} api should be same`,
        });
      }
    } catch (error: any) {
      console.error(
        `!!Error while checking message id for /${constants.ON_INIT}, ${error.stack}`
      );
    }

    const on_init = message.order;

    try {
      console.info(`Checking Cancellation terms for /${constants.ON_INIT}`);
      if (
        message.order.cancellation_terms &&
        message.order.cancellation_terms.length > 0
      ) {
        result.push({
          valid: false,
          code: 20000,
          description: `'cancellation_terms' in /message/order should not be provided as those are not enabled yet`,
        });
      }
    } catch (error: any) {
      console.error(
        `!!Error while checking Cancellation terms for /${constants.ON_INIT}, ${error.stack}`
      );
    }

    try {
      console.info(
        `Checking provider id and location in /${constants.CONFIRM}`
      );
      const providerIdRaw = await RedisService.getKey(
        `${transaction_id}_providerId`
      );
      const providerId = providerIdRaw ? JSON.parse(providerIdRaw) : null;
      if (on_init.provider.id != providerId) {
        result.push({
          valid: false,
          code: 20000,
          description: `Provider Id mismatches in /${constants.ON_SEARCH} and /${constants.CONFIRM}`,
        });
      }

      const providerLocRaw = await RedisService.getKey(
        `${transaction_id}_providerLoc`
      );
      const providerLoc = providerLocRaw ? JSON.parse(providerLocRaw) : null;
      if (
        on_init.provider.location &&
        on_init.provider.locations[0].id != providerLoc
      ) {
        result.push({
          valid: false,
          code: 20000,
          description: `provider.locations[0].id mismatches in /${constants.ON_SEARCH} and /${constants.CONFIRM}`,
        });
      }
    } catch (error: any) {
      console.error(
        `!!Error while checking provider id and location in /${constants.CONFIRM}, ${error.stack}`
      );
    }

    try {
      console.info(`Checking for tax_number for ${constants.ON_INIT}`);
      const bpp_terms_obj: any = message.order.tags.filter((item: any) => {
        return item?.code == "bpp_terms";
      })[0];
      const tags = bpp_terms_obj.list;
      const accept_bap_terms = tags.filter(
        (item: any) => item.code === "accept_bap_terms"
      );
      const np_type_on_search = await RedisService.getKey(
        `${transaction_id}_${ApiSequence.ON_SEARCH}np_type`
      );

      let tax_number: any = {};
      let provider_tax_number: any = {};
      if (accept_bap_terms.length > 0) {
        result.push({
          valid: false,
          code: 20000,
          description: `accept_bap_terms is not required for now!`,
        });
      }
      tags.forEach((e: any) => {
        if (e.code === "tax_number") {
          if (!e.value) {
            console.error(
              `value must be present for tax_number in ${constants.ON_INIT}`
            );
            result.push({
              valid: false,
              code: 20000,
              description: `value must be present for tax_number in ${constants.ON_INIT}`,
            });
          } else {
            const taxNumberPattern = new RegExp(
              "^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$"
            );
            if (!taxNumberPattern.test(e.value)) {
              console.error(
                `Invalid format for tax_number in ${constants.ON_INIT}`
              );
              result.push({
                valid: false,
                code: 20000,
                description: `Invalid format for tax_number in ${constants.ON_INIT}`,
              });
            }
          }
          tax_number = e;
        }
        if (e.code === "provider_tax_number") {
          if (!e.value) {
            console.error(
              `value must be present for provider_tax_number in ${constants.ON_INIT}`
            );
            result.push({
              valid: false,
              code: 20000,
              description: `value must be present for provider_tax_number in ${constants.ON_INIT}`,
            });
          } else {
            const taxNumberPattern = new RegExp("^[A-Z]{5}[0-9]{4}[A-Z]{1}$");
            if (!taxNumberPattern.test(e.value)) {
              console.error(
                `Invalid format for provider_tax_number in ${constants.ON_INIT}`
              );
              result.push({
                valid: false,
                code: 20000,
                description: `Invalid format for provider_tax_number in ${constants.ON_INIT}`,
              });
            }
          }
          provider_tax_number = e;
        }
      });
      if (_.isEmpty(tax_number)) {
        console.error(`tax_number must present in ${constants.ON_INIT}`);
        result.push({
          valid: false,
          code: 20000,
          description: `tax_number must be present for ${constants.ON_INIT}`,
        });
      }
      if (_.isEmpty(provider_tax_number)) {
        console.error(`tax_number must present in ${constants.ON_INIT}`);
        result.push({
          valid: false,
          code: 20000,
          description: `provider_tax_number must be present for ${constants.ON_INIT}`,
        });
      }
      if (
        tax_number.value?.length == 15 &&
        provider_tax_number?.value?.length == 10
      ) {
        const pan_id = tax_number?.value.slice(2, 12);
        if (
          pan_id != provider_tax_number?.value &&
          np_type_on_search == "ISN"
        ) {
          console.error(
            `Pan_id is different in tax_number and provider_tax_number in ${constants.ON_INIT}`
          );
          result.push({
            valid: false,
            code: 20000,
            description: `Pan_id is different in tax_number and provider_tax_number in message.order.tags[0].list`,
          });
        } else if (
          pan_id == provider_tax_number &&
          np_type_on_search == "MSN"
        ) {
          result.push({
            valid: false,
            code: 20000,
            description: `Pan_id shouldn't be same in tax_number and provider_tax_number in message.order.tags[0].list`,
          });
          console.error(
            "onCnfrmObj[`message.order.tags[0].list`] = `Pan_id shoudn't be same in tax_number and provider_tax_number in message.order.tags[0].list`"
          );
        }
      }
    } catch (error: any) {
      console.error(`tax_number not present in tags for ${constants.ON_INIT}`);
    }

    try {
      console.info(`Checking for tags in /${constants.ON_INIT}`);
      if (on_init.tags && isArray(on_init.tags)) {
        await RedisService.setKey(
          `${transaction_id}_bpp_tags`,
          JSON.stringify(
            on_init.tags.forEach(async (data: any) => {
              if (data.code == "bpp_terms") {
                await RedisService.setKey(
                  `${transaction_id}_list_ON_INIT`,
                  JSON.stringify(data.list),
                  TTL_IN_SECONDS
                );
              }
            })
          ),
          TTL_IN_SECONDS
        );
      }
    } catch (error: any) {
      console.error(
        `!!Error while checking tags in /${constants.ON_INIT} ${error.stack}`
      );
    }

    try {
      console.info(
        `Comparing item Ids and fulfillment Ids in /${constants.ON_SELECT} and /${constants.ON_INIT}`
      );
      const itemFlfllmntsRaw = await RedisService.getKey(
        `${transaction_id}_itemFlfllmnts`
      );
      const itemFlfllmnts = itemFlfllmntsRaw
        ? JSON.parse(itemFlfllmntsRaw)
        : null;
      const itemsIdListRaw = await RedisService.getKey(
        `${transaction_id}_itemsIdList`
      );
      const itemsIdList = itemsIdListRaw ? JSON.parse(itemsIdListRaw) : null;
      let i = 0;
      const len: any = on_init.items.length;
      while (i < len) {
        const itemId: any = on_init.items[i].id;
        const item = on_init.items[i];

        if (checkItemTag(item, select_customIdArray)) {
          result.push({
            valid: false,
            code: 20000,
            description: `items[${i}].tags.parent_id mismatches for Item ${itemId} in /${constants.SELECT} and /${constants.INIT}`,
          });
        }

        if (
          parentItemIdSet &&
          item.parent_item_id &&
          !parentItemIdSet.includes(item.parent_item_id)
        ) {
          result.push({
            valid: false,
            code: 20000,
            description: `items[${i}].parent_item_id mismatches for Item ${itemId} in /${constants.ON_SEARCH} and /${constants.ON_INIT}`,
          });
        }

        if (itemId in itemFlfllmnts) {
          if (on_init.items[i].fulfillment_id != itemFlfllmnts[itemId]) {
            result.push({
              valid: false,
              code: 20000,
              description: `items[${i}].fulfillment_id mismatches for Item ${itemId} in /${constants.ON_SELECT} and /${constants.ON_INIT}`,
            });
          }
        } else {
          result.push({
            valid: false,
            code: 20000,
            description: `Item Id ${itemId} does not exist in /on_select`,
          });
        }

        if (itemId in itemsIdList) {
          if (on_init.items[i].quantity.count != itemsIdList[itemId]) {
            result.push({
              valid: false,
              code: 20000,
              description: `Warning: items[${i}].quantity.count for item ${itemId} mismatches with the items quantity selected in /${constants.SELECT}`,
            });
          }
        }

        i++;
      }
    } catch (error: any) {
      console.error(
        `!!Error while comparing Item and Fulfillment Id in /${constants.ON_SELECT} and /${constants.ON_INIT}, ${error.stack}`
      );
    }

    try {
      console.info(`Validating fulfillments`);
      on_init?.fulfillments.forEach((fulfillment: any) => {
        const { type } = fulfillment;
        if (type == "Delivery") {
          if (fulfillment.tags && fulfillment.tags.length > 0) {
            result.push({
              valid: false,
              code: 20000,
              description: `/message/order/fulfillment of type 'delivery' should not have tags`,
            });
          }
        } else if (type !== "Delivery") {
          result.push({
            valid: false,
            code: 20000,
            description: `Fulfillment type should be 'Delivery' (case-sensitive)`,
          });
        }
      });
    } catch (error: any) {
      console.error(`Error while validating fulfillments, ${error.stack}`);
    }

    try {
      console.info("Checking fulfillment.id, fulfillment.type and tracking");
      on_init.fulfillments.forEach(async (ff: any) => {
        let ffId = "";

        if (!ff.id) {
          console.info(`Fulfillment Id must be present`);
          result.push({
            valid: false,
            code: 20000,
            description: `Fulfillment Id must be present`,
          });
        }

        ffId = ff.id;

        const trackingRaw = await RedisService.getKey(
          `${transaction_id}_${ffId}_tracking`
        );
        const tracking = trackingRaw ? JSON.parse(trackingRaw) : null;
        if (tracking) {
          if (ff.tracking === false || ff.tracking === true) {
            if (tracking != ff.tracking) {
              console.info(
                `Fulfillment Tracking mismatch with the ${constants.ON_SELECT} call`
              );
              result.push({
                valid: false,
                code: 20000,
                description: `Fulfillment Tracking mismatch with the ${constants.ON_SELECT} call`,
              });
            }
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
        `Error while checking fulfillments id, type and tracking in /${constants.ON_INIT}`
      );
    }

    try {
      console.info(
        `Comparing billing object in /${constants.INIT} and /${constants.ON_INIT}`
      );
      const billingRaw = await RedisService.getKey(`${transaction_id}_billing`);
      const billing = billingRaw ? JSON.parse(billingRaw) : null;

      const billingErrors = compareObjects(billing, on_init.billing);

      if (billingErrors) {
        let i = 0;
        const len = billingErrors.length;
        while (i < len) {
          result.push({
            valid: false,
            code: 20000,
            description: `${billingErrors[i]}  when compared with init billing object`,
          });
          i++;
        }
      }
    } catch (error: any) {
      console.error(
        `!!Error while comparing billing object in /${constants.INIT} and /${constants.ON_INIT}, ${error.stack}`
      );
    }

    try {
      console.info(`Checking fulfillments objects in /${constants.ON_INIT}`);
      const itemFlfllmntsRaw = await RedisService.getKey(
        `${transaction_id}_itemFlfllmnts`
      );
      const itemFlfllmnts = itemFlfllmntsRaw
        ? JSON.parse(itemFlfllmntsRaw)
        : null;
      const buyerGpsRaw = await RedisService.getKey(
        `${transaction_id}_buyerGps`
      );
      const buyerGps = buyerGpsRaw ? JSON.parse(buyerGpsRaw) : null;
      const buyerAddrRaw = await RedisService.getKey(
        `${transaction_id}_buyerAddr`
      );
      const buyerAddr = buyerAddrRaw ? JSON.parse(buyerAddrRaw) : null;
      let i = 0;
      const len = on_init.fulfillments.length;
      while (i < len) {
        if (on_init.fulfillments[i].id) {
          const id = on_init.fulfillments[i].id;
          if (!Object.values(itemFlfllmnts).includes(id)) {
            result.push({
              valid: false,
              code: 20000,
              description: `fulfillment id ${id} does not exist in /${constants.ON_SELECT}`,
            });
          }
        } else {
          result.push({
            valid: false,
            code: 20000,
            description: `fulfillments[].id is missing in /${constants.ON_INIT}`,
          });
        }

        if (!_.isEqual(on_init.fulfillments[i].end.location.gps, buyerGps)) {
          result.push({
            valid: false,
            code: 20000,
            description: `gps coordinates in fulfillments[${i}].end.location mismatch in /${constants.SELECT} & /${constants.ON_INIT}`,
          });
        }

        if (
          !_.isEqual(
            on_init.fulfillments[i].end.location.address.area_code,
            buyerAddr
          )
        ) {
          result.push({
            valid: false,
            code: 20000,
            description: `address.area_code in fulfillments[${i}].end.location mismatch in /${constants.SELECT} & /${constants.ON_INIT}`,
          });
        }

        i++;
      }
    } catch (error: any) {
      console.error(
        `!!Error while checking fulfillments object in /${constants.ON_INIT}, ${error.stack}`
      );
    }

    try {
      let initQuotePrice = 0;
      let initBreakupPrice = 0;
      console.info(`Calculating Net /${constants.ON_INIT} Price breakup`);
      on_init.quote.breakup.forEach((element: { price: { value: string } }) => {
        initBreakupPrice += parseFloat(element.price.value);
      });
      console.info(`/${constants.ON_INIT} Price Breakup: ${initBreakupPrice}`);

      initQuotePrice = parseFloat(on_init.quote.price.value);
      await RedisService.setKey(
        `${transaction_id}_initQuotePrice`,
        JSON.stringify(initQuotePrice),
        TTL_IN_SECONDS
      );
      console.info(`/${constants.ON_INIT} Quoted Price: ${initQuotePrice}`);

      console.info(
        `Comparing /${constants.ON_INIT} Quoted Price and Net Price Breakup`
      );
      if (Math.round(initQuotePrice) != Math.round(initBreakupPrice)) {
        console.info(
          `Quoted Price in /${constants.ON_INIT} is not equal to the Net Breakup Price`
        );
        result.push({
          valid: false,
          code: 20000,
          description: `Quoted Price ${initQuotePrice} does not match with Net Breakup Price ${initBreakupPrice} in /${constants.ON_INIT}`,
        });
      }

      console.info(
        `Comparing /${constants.ON_INIT} Quoted Price and /${constants.ON_SELECT} Quoted Price`
      );
      const onSelectPriceRaw = await RedisService.getKey(
        `${transaction_id}_onSelectPrice`
      );
      const onSelectPrice = onSelectPriceRaw
        ? JSON.parse(onSelectPriceRaw)
        : null;
      if (Math.round(onSelectPrice) != Math.round(initQuotePrice)) {
        console.info(
          `Quoted Price in /${constants.ON_INIT} is not equal to the quoted price in /${constants.ON_SELECT}`
        );
        result.push({
          valid: false,
          code: 20000,
          description: `Quoted Price in /${constants.ON_INIT} INR ${initQuotePrice} does not match with the quoted price in /${constants.ON_SELECT} INR ${onSelectPrice}`,
        });
      }

      console.info(`Checking Payment Object for  /${constants.ON_INIT}`);
      if (!on_init.payment) {
        result.push({
          valid: false,
          code: 20000,
          description: `Payment Object can't be null in /${constants.ON_INIT}`,
        });
      }
    } catch (error: any) {
      console.error(
        `!!Error while checking /${constants.ON_INIT} Quoted Price and Net Price Breakup, ${error.stack}`
      );
    }

    try {
      console.info(
        `Checking Buyer App finder fee amount in /${constants.ON_INIT}`
      );
      const buyerFFRaw = await RedisService.getKey(
        `${transaction_id}_${ApiSequence.SEARCH}_buyerFF`
      );
      const buyerFF = buyerFFRaw ? JSON.parse(buyerFFRaw) : null;
      if (
        !on_init.payment["@ondc/org/buyer_app_finder_fee_amount"] ||
        parseFloat(on_init.payment["@ondc/org/buyer_app_finder_fee_amount"]) !=
        buyerFF
      ) {
        result.push({
          valid: false,
          code: 20000,
          description: `Buyer app finder fee can't change in /${constants.ON_INIT}`,
        });
      }
    } catch (error: any) {
      console.error(
        `!!Error while checking buyer app finder fee in /${constants.ON_INIT}, ${error.stack}`
      );
    }

    try {
      console.info(`Checking Settlement basis in /${constants.ON_INIT}`);
      const validSettlementBasis = ["delivery", "shipment"];
      const settlementBasis = on_init.payment["@ondc/org/settlement_basis"];
      if (!validSettlementBasis.includes(settlementBasis)) {
        result.push({
          valid: false,
          code: 20000,
          description: `Invalid settlement basis in /${constants.ON_INIT
            }. Expected one of: ${validSettlementBasis.join(", ")}`,
        });
      }
    } catch (error: any) {
      console.error(
        `!!Error while checking settlement basis in /${constants.ON_INIT}, ${error.stack}`
      );
    }

    try {
      console.info(`Checking Settlement Window in /${constants.ON_INIT}`);
      const validSettlementWindow = {
        code: "SETTLEMENT_WINDOW",
        type: "time",
        value:
          /^P(?=\d|T\d)(\d+Y)?(\d+M)?(\d+D)?(T(?=\d)(\d+H)?(\d+M)?(\d+(\.\d+)?S)?)?$/,
      };
      const settlementWindow = on_init.payment["@ondc/org/settlement_window"];
      if (!validSettlementWindow.value.test(settlementWindow)) {
        result.push({
          valid: false,
          code: 20000,
          description: `Invalid settlement window in /${constants.ON_INIT}. Expected format: PTd+[MH] (e.g., PT1H, PT30M).`,
        });
      }
    } catch (err: any) {
      console.error("Error while checking settlement window: " + err.message);
    }

    try {
      console.info(`checking payment object in /${constants.ON_INIT}`);
      if (
        on_init.payment["@ondc/org/settlement_details"][0][
        "settlement_counterparty"
        ] != "seller-app"
      ) {
        result.push({
          valid: false,
          code: 20000,
          description: `settlement_counterparty is expected to be 'seller-app' in @ondc/org/settlement_details`,
        });
      }

      console.info(`checking payment details in /${constants.ON_INIT}`);
      const data = on_init.payment["@ondc/org/settlement_details"][0];
      if (
        data["settlement_type"] !== "neft" &&
        data["settlement_type"] !== "rtgs" &&
        data["settlement_type"] !== "upi"
      ) {
        console.error(
          `settlement_type is expected to be 'neft/rtgs/upi' in @ondc/org/settlement_detailsin /${constants.ON_INIT}`
        );
        result.push({
          valid: false,
          code: 20000,
          description: `settlement_type is expected to be 'neft/rtgs/upi' in @ondc/org/settlement_details`,
        });
      } else if (data["settlement_type"] !== "upi") {
        let missingFields: any = [];
        if (!data.bank_name) {
          missingFields.push("bank_name");
        }
        if (!data.branch_name) {
          missingFields.push("branch_name");
        }
        if (!data.beneficiary_name || data.beneficiary_name.trim() === "") {
          missingFields.push("beneficiary_name");
        }
        if (!data.settlement_phase) {
          missingFields.push("settlement_phase");
        }
        if (!data.settlement_ifsc_code) {
          missingFields.push("settlement_ifsc_code");
        }
        if (!data.settlement_counterparty) {
          missingFields.push("settlement_counterparty");
        }
        if (
          !data.settlement_bank_account_no ||
          data.settlement_bank_account_no.trim() === ""
        ) {
          missingFields.push("settlement_bank_account_no");
        }

        if (missingFields.length > 0) {
          console.error(
            `Payment details are missing: ${missingFields.join(", ")} /${constants.ON_INIT
            }`
          );
          result.push({
            valid: false,
            code: 20000,
            description: `Payment details are missing: ${missingFields.join(
              ", "
            )}/${constants.ON_INIT}`,
          });
        }
      } else {
        if (!data.upi_address || data.upi_address.trim() === "") {
          console.error(`Payment details are missing /${constants.ON_INIT}`);
          result.push({
            valid: false,
            code: 20000,
            description: `Payment details are missing/${constants.ON_INIT}`,
          });
        }
      }
    } catch (error: any) {
      console.error(
        `!!Error while checking payment object in /${constants.ON_INIT}`
      );
    }

    try {
      console.info(
        `storing payment settlement details in /${constants.ON_INIT}`
      );
      if (on_init.payment.hasOwnProperty("@ondc/org/settlement_details")) {
        await RedisService.setKey(
          `${transaction_id}_sttlmntdtls`,
          JSON.stringify(on_init.payment["@ondc/org/settlement_details"][0]),
          TTL_IN_SECONDS
        );
      } else {
        result.push({
          valid: false,
          code: 20000,
          description: `payment settlement_details missing in /${constants.ON_INIT}`,
        });
      }
    } catch (error: any) {
      console.error(
        `!!Error while storing payment settlement details in /${constants.ON_INIT}`
      );
    }

    try {
      console.info(
        `Checking Quote Object in /${constants.ON_SELECT} and /${constants.ON_INIT}`
      );
      const on_select_quoteRaw = await RedisService.getKey(
        `${transaction_id}_quoteObj`
      );
      const on_select_quote = on_select_quoteRaw
        ? JSON.parse(on_select_quoteRaw)
        : null;

      console.log(
        "quoteDiff",
        JSON.stringify(on_select_quote),
        JSON.stringify(on_init.quote)
      );
      const quoteErrors = compareQuoteObjects(
        on_select_quote,
        on_init.quote,
        constants.ON_SELECT,
        constants.ON_INIT
      );
      const hasItemWithQuantity = _.some(on_init.quote.breakup, (item) =>
        _.has(item, "item.quantity")
      );
      if (hasItemWithQuantity) {
        result.push({
          valid: false,
          code: 20000,
          description: `Extra attribute Quantity provided in quote object i.e not supposed to be provided after on_select so invalid quote object`,
        });
      } else if (quoteErrors) {
        let i = 0;
        const len = quoteErrors.length;
        while (i < len) {
          result.push({
            valid: false,
            code: 20000,
            description: `${quoteErrors[i]}`,
          });
          i++;
        }
      }
    } catch (error: any) {
      console.error(
        `!!Error while checking quote object in /${constants.ON_SELECT} and /${constants.ON_INIT}`
      );
    }

    try {
      if (on_init.tags) {
        const isValid = isTagsValid(on_init.tags, "bpp_terms");
        if (isValid === false) {
          result.push({
            valid: false,
            code: 20000,
            description: `Tags should have valid gst number and fields in /${constants.ON_INIT}`,
          });
        }

        await RedisService.setKey(
          `${transaction_id}_on_init_tags`,
          JSON.stringify(on_init.tags),
          TTL_IN_SECONDS
        );
      }
    } catch (error: any) {
      console.error(
        `!!Error while checking tags in /${constants.ON_INIT} ${error.stack}`
      );
    }

    try {
      console.info(`Checking bap_terms  in ${constants.ON_INIT}`);
      const tags = on_init.tags;
      for (const tag of tags) {
        if (tag.code === "bap_terms") {
          const hasStaticTerms = tag.list.some(
            (item: { code: string }) => item.code === "static_terms"
          );
          if (hasStaticTerms) {
            result.push({
              valid: false,
              code: 20000,
              description: `static_terms is not required for now! in ${constants.ON_INIT}`,
            });
          }
        }
      }
    } catch (err: any) {
      console.error(
        `Error while Checking bap_terms in ${constants.ON_INIT}, ${err.stack}`
      );
    }

    try {
      console.info(
        `Checking if transaction_id is present in message.order.payment`
      );
      const payment = on_init.payment;
      const status = payment_status(payment, flow);
      if (!status) {
        result.push({
          valid: false,
          code: 20000,
          description: `Transaction_id missing in message/order/payment`,
        });
      }
    } catch (err: any) {
      console.error(
        `Error while checking transaction is in message.order.payment`
      );
    }

    try {
      console.info(`Checking if the amount is paid or not`);
      const payment = on_init.payment;
      const status = payment_status(payment, flow);
      if (status && status.message) {
        console.error(status.message);
        result.push({
          valid: false,
          code: 20000,
          description: status.message,
        });
      } else {
        console.info("Payment status is valid.");
      }
    } catch (err: any) {
      console.error(`Error while handling payment status: ${err.stack}`);
      result.push({
        valid: false,
        code: 20000,
        description: "Payment status can not be paid (COD flow)",
      });
    }

    try {
      console.info(`Validating tags`);
      on_init?.tags.forEach((tag: any) => {
        const providerTaxNumber = tag.list.find(
          (item: any) => item.code === "provider_tax_number"
        );
        if (providerTaxNumber) {
          const panRegex = /^[A-Z]{5}[0-9]{4}[A-Z]{1}$/;
          if (!panRegex.test(providerTaxNumber.value)) {
            result.push({
              valid: false,
              code: 20000,
              description: `'provider_tax_number' should have a valid PAN number format`,
            });
          }
        }
      });
    } catch (error: any) {
      console.error(`Error while validating tags, ${error.stack}`);
    }

    return result;
  } catch (err: any) {
    console.error(
      `!!Some error occurred while checking /${constants.ON_INIT} API`,
      err
    );
    return result;
  }
};
export default onInit;
