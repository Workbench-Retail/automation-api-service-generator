import _ from "lodash";
import constants, {
  ApiSequence,
  buyerCancellationRid,
} from "./../utils/constants";
import { isValidISO8601Duration } from "./../utils/helper";
import { RedisService } from "ondc-automation-cache-lib";
import { contextChecker } from "./../utils/contextUtils";
const addError = (result: any[], code: number, description: string): void => {
  result.push({
    valid: false,
    code,
    description,
  });
};
export const cancel = async (data: any) => {
  const TTL_IN_SECONDS: number = Number(process.env.TTL_IN_SECONDS) || 3600;
  const result: any[] = [];
  const { message, context }: any = data;
  try {
    try {
      await contextChecker(
        context,
        result,
        constants.CANCEL,
        constants.ON_CONFIRM
      );
    } catch (err: any) {
      addError(result, 20000, `Error checking context: ${err.message}`);
      return result;
    }

    const confirmOrderIdKey = `${context.transaction_id}_cnfrmOrdrId`;
    const cancelMsgIdKey = `${context.transaction_id}_${ApiSequence.CANCEL}_msgId`;
    const cancelDataKey = `${context.transaction_id}_${ApiSequence.CANCEL}`;
    const cancelReasonIdKey = `${context.transaction_id}_cnclRid`;

    // Store cancel data
    await RedisService.setKey(
      cancelDataKey,
      JSON.stringify(data),
      TTL_IN_SECONDS
    );

    const cancel = message;

    try {
      console.info("Checking the validity of cancellation reason id for buyer");
      if (!buyerCancellationRid.has(cancel?.cancellation_reason_id)) {
        console.info(
          `cancellation_reason_id should be a valid cancellation id (buyer app initiated)`
        );
        result.push({
          valid: false,
          code: 30012,
          description: `Cancellation reason id is not a valid reason id (buyer app initiated)`,
        });
      } else {
        await RedisService.setKey(
          cancelReasonIdKey,
          cancel?.cancellation_reason_id,
          TTL_IN_SECONDS
        );
      }
    } catch (error: any) {
      console.info(
        `Error while checking validity of cancellation reason id /${constants.CANCEL}, ${error.stack}`
      );
    }

    if (cancel.descriptor) {
      const { name, short_desc, tags } = cancel.descriptor;

      // Validate descriptor fields
      if (!name || name !== "fulfillment") {
        result.push({
          valid: false,
          code: 40000,
          description: `message/descriptor/name must be 'fulfillment' in /${constants.CANCEL}`,
        });
      }
      if (!short_desc) {
        result.push({
          valid: false,
          code: 40000,
          description: `message/descriptor/short_desc is missing in /${constants.CANCEL}`,
        });
      }

      // Validate tags array
      if (!tags || !Array.isArray(tags) || tags.length === 0) {
      } else {
        const paramsTag = tags.find((tag: any) => tag.code === "params");
        if (!paramsTag || !paramsTag.list || !Array.isArray(paramsTag.list)) {
          result.push({
            valid: false,
            code: 40000,
            description: `message/descriptor/tags must contain a 'params' tag with a valid list in /${constants.CANCEL}`,
          });
        } else {
          const forceParam = paramsTag.list.find(
            (item: any) => item.code === "force"
          );
          const ttlResponseParam = paramsTag.list.find(
            (item: any) => item.code === "ttl_response"
          );

          // Validate force parameter
          if (!forceParam || !forceParam.code) {
            result.push({
              valid: false,
              code: 40000,
              description: `message/descriptor/tags/params must contain a 'force' parameter in /${constants.CANCEL}`,
            });
          } else if (!["yes", "no"].includes(forceParam.value)) {
            result.push({
              valid: false,
              code: 30024,
              description: `message/descriptor/tags/params/force must be 'yes' or 'no' in /${constants.CANCEL}`,
            });
          }

          if (!ttlResponseParam || !ttlResponseParam.value) {
            result.push({
              valid: false,
              code: 40000,
              description: `message/descriptor/tags/params must contain a 'ttl_response' parameter in /${constants.CANCEL}`,
            });
          } else if (!isValidISO8601Duration(ttlResponseParam.value)) {
            result.push({
              valid: false,
              code: 30025,
              description: `message/descriptor/tags/params/ttl_response must be a valid ISO8601 duration in /${constants.CANCEL}`,
            });
          }
        }
      }
    }

    // Store confirm data
    await RedisService.setKey(
      `${context.transaction_id}_${ApiSequence.CANCEL}`,
      JSON.stringify(data),
      TTL_IN_SECONDS
    );

    return result;
  } catch (err: any) {
    console.error(
      `!!Some error occurred while checking /${constants.CANCEL} API, ${err.stack}`
    );
    result.push({
      valid: false,
      code: 40000,
      description: `Some error occurred while checking /${constants.CANCEL} API`,
    });
    return result;
  }
};
