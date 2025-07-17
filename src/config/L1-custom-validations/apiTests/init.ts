import _ from "lodash";

import { RedisService } from "ondc-automation-cache-lib";
import {
  addActionToRedisSet,
  addMsgIdToRedisSet,
  checkBppIdOrBapId,
  checkContext,
  checkItemTag,
  isObjectEmpty,
} from "../utils/helper";
import constants, { ApiSequence } from "../utils/constants";

const init = async (data: any) => {
  const result: any[] = [];
  const TTL_IN_SECONDS: number = Number(process.env.TTL_IN_SECONDS) || 3600;
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
    const parentItemIdSetRaw = await RedisService.getKey(
      `${transaction_id}_parentItemIdSet`
    );
    const parentItemIdSet = parentItemIdSetRaw
      ? JSON.parse(parentItemIdSetRaw)
      : null;
    const customIdArrayRaw = await RedisService.getKey(
      `${transaction_id}_select_customIdArray`
    );
    const select_customIdArray = customIdArrayRaw
      ? JSON.parse(customIdArrayRaw)
      : null;

    const contextRes: any = checkContext(context, constants.INIT);

  

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

    try {
      if (
        _.isEqual(
          context,
          await RedisService.getKey(`${transaction_id}_domain`)
        )
      ) {
        result.push({
          valid: false,
          code: 20000,
          description: `Domain should be same in each action`,
        });
      }
    } catch (err) {
      console.error(err);
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

    await RedisService.setKey(
      `${transaction_id}_${ApiSequence.INIT}`,
      JSON.stringify(data),
      TTL_IN_SECONDS
    );

    try {
      console.info(`Checking context for /${constants.INIT} API`);
      const res: any = checkContext(context, constants.INIT);
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
        `!!Some error occurred while checking /${constants.INIT} context, ${error.stack}`
      );
    }

    try {
      console.info(
        `Comparing city of /${constants.SEARCH} and /${constants.INIT}`
      );
      if (!_.isEqual(searchContext.city, context.city)) {
        result.push({
          valid: false,
          code: 20000,
          description: `City code mismatch in /${constants.SEARCH} and /${constants.INIT}`,
        });
      }
    } catch (error: any) {
      console.info(
        `Error while comparing city in /${constants.SEARCH} and /${constants.INIT}, ${error.stack}`
      );
    }

    try {
      console.info(
        `Comparing timestamp of /${constants.ON_SELECT} and /${constants.INIT}`
      );
      const tmpRaw = await RedisService.getKey(
        `${transaction_id}_${ApiSequence.ON_SELECT}_tmpstmp`
      );
      const tmpstmp = tmpRaw ? JSON.parse(tmpRaw) : null;
      if (_.gte(tmpstmp, context.timestamp)) {
        result.push({
          valid: false,
          code: 20000,
          description: `Timestamp for  /${constants.ON_SELECT} api cannot be greater than or equal to /init api`,
        });
      }
      await RedisService.setKey(
        `${transaction_id}_${ApiSequence.INIT}_tmpstmp`,
        JSON.stringify(context.timestamp),
        TTL_IN_SECONDS
      );
    } catch (error: any) {
      console.error(
        `!!Error while comparing timestamp for /${constants.ON_SELECT} and /${constants.INIT} api, ${error.stack}`
      );
    }

    try {
      console.info(`Adding Message Id /${constants.INIT}`);
      const isMsgIdNotPresent = await addMsgIdToRedisSet(
        context.transaction_id,
        context.message_id,
        ApiSequence.INIT
      );
      if (!isMsgIdNotPresent) {
        result.push({
          valid: false,
          code: 20000,
          description: `Message id should not be same with previous calls`,
        });
      }
      await RedisService.setKey(
        `${transaction_id}_${ApiSequence.INIT}_msgId`,
        JSON.stringify(data.context.message_id),
        TTL_IN_SECONDS
      );
    } catch (error: any) {
      console.error(
        `!!Error while checking message id for /${constants.INIT}, ${error.stack}`
      );
    }

    const init = message.order;

    try {
      console.info(
        `Comparing provider object in /${constants.SELECT} and /${constants.INIT}`
      );

      const providerIdRaw = await RedisService.getKey(
        `${transaction_id}_providerId`
      );
      const providerId = providerIdRaw ? JSON.parse(providerIdRaw) : null;

      if (providerId != init.provider["id"]) {
        result.push({
          valid: false,
          code: 20000,
          description: `Provider Id mismatches in /${constants.SELECT} and /${constants.INIT}`,
        });
      }

      const providerLocRaw = await RedisService.getKey(
        `${transaction_id}_providerLoc`
      );
      const providerLoc = providerLocRaw ? JSON.parse(providerLocRaw) : null;
      if (providerLoc != init.provider.locations[0].id) {
        result.push({
          valid: false,
          code: 20000,
          description: `Provider.locations[0].id mismatches in /${constants.SELECT} and /${constants.INIT}`,
        });
      }
    } catch (error: any) {
      console.error(
        `!!Error while checking provider object in /${constants.SELECT} and /${constants.INIT}, ${error.stack}`
      );
    }

    try {
      console.info(`Checking address components length`);
      const noOfFulfillments = init.fulfillments.length;
      let i = 0;
      while (i < noOfFulfillments) {
        const address = init.fulfillments[i].end.location.address;
        const lenName = address.name.length;
        const lenBuilding = address.building.length;
        const lenLocality = address.locality.length;

        if (lenName + lenBuilding + lenLocality >= 190) {
          result.push({
            valid: false,
            code: 20000,
            description: `address.name + address.building + address.locality should be less than 190 chars`,
          });
        }

        if (lenBuilding <= 3) {
          result.push({
            valid: false,
            code: 20000,
            description: `address.building should be more than 3 chars`,
          });
        }

        if (lenName <= 3) {
          result.push({
            valid: false,
            code: 20000,
            description: `address.name should be more than 3 chars`,
          });
        }

        if (lenLocality <= 3) {
          result.push({
            valid: false,
            code: 20000,
            description: `address.locality should be more than 3 chars`,
          });
        }

        if (
          address.building === address.locality ||
          address.name === address.building ||
          address.name === address.locality
        ) {
          result.push({
            valid: false,
            code: 20000,
            description: `value of address.name, address.building and address.locality should be unique`,
          });
        }

        i++;
      }
    } catch (error: any) {
      console.error(
        `!!Error while checking address components in /${constants.INIT}, ${error.stack}`
      );
    }

    try {
      console.info(`Storing billing address in /${constants.INIT}`);
      await RedisService.setKey(
        `${transaction_id}_billing`,
        JSON.stringify(init.billing),
        TTL_IN_SECONDS
      );
    } catch (error: any) {
      console.error(
        `!!Error while storing billing object in /${constants.INIT}, ${error.stack}`
      );
    }

    try {
      console.info(
        `Comparing item Ids and fulfillment ids in /${constants.ON_SELECT} and /${constants.INIT}`
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
      const len = init.items.length;
      while (i < len) {
        const itemId = init.items[i].id;
        const item = init.items[i];

        if (checkItemTag(item, select_customIdArray)) {
          result.push({
            valid: false,
            code: 20000,
            description: `items[${i}].tags.parent_id mismatches for Item ${itemId} in /${constants.ON_SEARCH} and /${constants.INIT}`,
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
            description: `items[${i}].parent_item_id mismatches for Item ${itemId} in /${constants.ON_SEARCH} and /${constants.INIT}`,
          });
        }

        if (itemId in itemFlfllmnts) {
          if (init.items[i].fulfillment_id != itemFlfllmnts[itemId]) {
            result.push({
              valid: false,
              code: 20000,
              description: `items[${i}].fulfillment_id mismatches for Item ${itemId} in /${constants.ON_SELECT} and /${constants.INIT}`,
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
          if (init.items[i].quantity.count != itemsIdList[itemId]) {
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
        `!!Error while comparing Item and Fulfillment Id in /${constants.ON_SELECT} and /${constants.INIT}`
      );
    }

    try {
      console.info(`Checking fulfillments objects in /${constants.INIT}`);
      const itemFlfllmntsRaw = await RedisService.getKey(
        `${transaction_id}_itemFlfllmnts`
      );
      const itemFlfllmnts = itemFlfllmntsRaw
        ? JSON.parse(itemFlfllmntsRaw)
        : null;
      let i = 0;
      const len = init.fulfillments.length;
      while (i < len) {
        const id = init.fulfillments[i].id;
        if (id) {
          if (!Object.values(itemFlfllmnts).includes(id)) {
            result.push({
              valid: false,
              code: 20000,
              description: `fulfillment id ${id} does not exist in /${constants.ON_SELECT}`,
            });
          }
          const buyerGpsRaw = await RedisService.getKey(
            `${transaction_id}_buyerGps`
          );
          const buyerGps = buyerGpsRaw ? JSON.parse(buyerGpsRaw) : null;
          if (!_.isEqual(init.fulfillments[i].end.location.gps, buyerGps)) {
            result.push({
              valid: false,
              code: 20000,
              description: `gps coordinates in fulfillments[${i}].end.location mismatch in /${constants.SELECT} & /${constants.INIT}`,
            });
          }
          const buyerAddrRaw = await RedisService.getKey(
            `${transaction_id}_buyerAddr`
          );
          const buyerAddr = buyerAddrRaw ? JSON.parse(buyerAddrRaw) : null;
          if (
            !_.isEqual(
              init.fulfillments[i].end.location.address.area_code,
              buyerAddr
            )
          ) {
            result.push({
              valid: false,
              code: 20000,
              description: `address.area_code in fulfillments[${i}].end.location mismatch in /${constants.SELECT} & /${constants.INIT}`,
            });
          }
        } else {
          result.push({
            valid: false,
            code: 20000,
            description: `fulfillments[${i}].id is missing in /${constants.INIT}`,
          });
        }

        i++;
      }
    } catch (error: any) {
      console.error(
        `!!Error while checking fulfillments object in /${constants.INIT}, ${error.stack}`
      );
    }

    return result;
  } catch (err: any) {
    console.error(
      `!!Some error occurred while checking /${constants.INIT} API`,
      err
    );
    return result;
  }
};

export default init;
