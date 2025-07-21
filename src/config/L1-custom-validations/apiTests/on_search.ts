import constants, { ApiSequence } from "../utils/constants";
import {
  isObjectEmpty,
  checkContext,
  checkGpsPrecision,
  emailRegex,
  checkBppIdOrBapId,
  checkServiceabilityType,
  validateLocations,
  isValidPhoneNumber,
  compareSTDwithArea,
  areTimestampsLessThanOrEqualTo,
  validateObjectString,
  validateBapUri,
  validateBppUri,
  addActionToRedisSet,
} from "../utils/helper";
import _, { isEmpty } from "lodash";
import {
  calculateDefaultSelectionPrice,
  extractCustomGroups,
  mapCustomItemToTreeNode,
  mapCustomizationsToBaseItems,
  mapItemToTreeNode,
} from "../utils/fb_calculation/default_selection/utils";
import { RedisService } from "ondc-automation-cache-lib";

interface ValidationError {
  valid: boolean;
  code: number;
  description: string;
}

type validationOutput = ValidationError[];

export default async function onSearch(
  payload: any
): Promise<validationOutput> {
  const result: validationOutput = [];
  const TTL_IN_SECONDS: number = Number(process.env.TTL_IN_SECONDS) || 3600;

  // Helper function to add validation errors
  const addError = (code: number, description: string) => {
    result.push({ valid: false, code, description });
    console.log("result", result);
  };

  try {
    console.info(
      `Checking JSON structure and required fields for ${ApiSequence.ON_SEARCH} API`
    );

    if (!payload || isObjectEmpty(payload)) {
      addError(20000, "Payload is missing or empty");
      return result;
    }

    const { message, context } = payload;
    if (
      !message ||
      !context ||
      !message.catalog ||
      isObjectEmpty(message) ||
      isObjectEmpty(message.catalog)
    ) {
      addError(
        20000,
        "/context, /message, /catalog, or /message/catalog is missing or empty"
      );
      return result;
    }

    const transaction_id = context?.transaction_id;


    await RedisService.setKey(
      `${transaction_id}_${ApiSequence.ON_SEARCH}_context`,
      JSON.stringify(context),
      TTL_IN_SECONDS
    );
    await RedisService.setKey(
      `${transaction_id}_${ApiSequence.ON_SEARCH}_message`,
      JSON.stringify(message),
      TTL_IN_SECONDS
    );

    const storedDomain = await RedisService.getKey(`${transaction_id}_domain`);
    if (!_.isEqual(payload.context.domain.split(":")[1], storedDomain)) {
      addError(20006, `Domain should be same in each action`);
    }

    const checkBap = checkBppIdOrBapId(context.bap_id);
    const checkBpp = checkBppIdOrBapId(context.bpp_id);
    if (checkBap) {
      addError(20006, "context/bap_id should not be a url");
    }
    if (checkBpp) {
      addError(20006, "context/bpp_id should not be a url");
    }

    const contextRes: any = checkContext(context, constants.ON_SEARCH);
    if (!contextRes?.valid) {
      contextRes.ERRORS.forEach((err: any) =>
        addError(20006, err.description || "Context validation failed")
      );
    }

    if (context.transaction_id === context.message_id) {
      addError(
        20006,
        `Context transaction_id (${context.transaction_id}) and message_id (${context.message_id}) can't be the same`
      );
    }

    await RedisService.setKey(
      `${transaction_id}_${ApiSequence.ON_SEARCH}`,
      JSON.stringify(payload),
      TTL_IN_SECONDS
    );

    const searchContextRaw = await RedisService.getKey(
      `${transaction_id}_${ApiSequence.SEARCH}_context`
    );
    const searchContext = JSON.parse(searchContextRaw || "{}");

    try {
      console.info(`Storing BAP_ID and BPP_ID in /${constants.ON_SEARCH}`);
      await RedisService.setKey(
        `${transaction_id}_bapId`,
        JSON.stringify(context.bap_id),
        TTL_IN_SECONDS
      );
      await RedisService.setKey(
        `${transaction_id}_bppId`,
        JSON.stringify(context.bpp_id),
        TTL_IN_SECONDS
      );
    } catch (error: any) {
      console.error(
        `!!Error while storing BAP and BPP Ids in /${constants.ON_SEARCH}, ${error.stack}`
      );
    }

    try {
      console.info(
        `Comparing timestamp of /${ApiSequence.SEARCH} /${ApiSequence.ON_SEARCH}`
      );
      if (searchContext.timestamp === context.timestamp) {
        addError(
          20006,
          `context/timestamp of /${constants.SEARCH} and /${constants.ON_SEARCH} api cannot be same`
        );
      }
    } catch (error: any) {
      console.error(
        `!!Error while comparing timestamp of /${ApiSequence.SEARCH} /${ApiSequence.ON_SEARCH}, ${error.stack}`
      );
    }

    try {
      console.info(
        `Checking customizations based on config.min and config.max values...`
      );
      const itemsRaw = await RedisService.getKey(`${transaction_id}_items`);
      const items = JSON.parse(itemsRaw || "[]");

      _.filter(items, (item) => {
        const customGroup = item.custom_group;

        if (customGroup?.config?.min === 1) {
          console.info(`Checking min value for item id: ${item.id}`);
          const defaultCustomizations = _.filter(
            item.customizations,
            (customization) => {
              return customization.is_default;
            }
          );

          if (defaultCustomizations.length < 1) {
            addError(
              20006,
              `Item with id: ${item.id} must have at least one default customization as config.min is set to 1`
            );
          }
        }

        if (customGroup?.config?.max === 2) {
          console.info(`Checking max value for item id: ${item.id}`);
          const customizationsCount = item.customizations.length;
          if (customizationsCount > 2) {
            addError(
              20006,
              `Item with id: ${item.id} can have at most 2 customizations as config.max is set to 2`
            );
          }
        }
      });
    } catch (error: any) {
      console.error(
        `Error while checking customizations for items, ${error.stack}`
      );
    }
    const onSearchCatalog: any = message.catalog;
    const onSearchFFIdsArray: any = [];
    const prvdrsId = new Set();
    const prvdrLocId = new Set();
    const onSearchFFTypeSet = new Set();
    const itemsId = new Set();
    let customMenuIds: any = [];
    let customMenu = false;

    try {
      console.info(`Saving static fulfillment ids in /${constants.ON_SEARCH}`);
      onSearchCatalog["bpp/providers"].forEach((provider: any) => {
        const onSearchFFIds = new Set();
        const bppFF = provider.fulfillments;
        const len = bppFF.length;

        let i = 0;
        while (i < len) {
          onSearchFFTypeSet.add(bppFF[i].type);
          onSearchFFIds.add(bppFF[i].id);
          i++;
        }
        onSearchFFIdsArray.push(onSearchFFIds);
      });

      await RedisService.setKey(
        `${transaction_id}_onSearchFFIdsArray`,
        JSON.stringify([...onSearchFFIdsArray]),
        TTL_IN_SECONDS
      );
    } catch (error: any) {
      console.info(
        `Error while saving static fulfillment ids in /${constants.ON_SEARCH}, ${error.stack}`
      );
    }

    try {
      console.info(`Checking for upcoming holidays`);
      const location = onSearchCatalog["bpp/providers"][0]["locations"];
      if (!location) {
        console.error("No location detected");
      } else {
        const scheduleObject = location[0].time.schedule.holidays;
        const timestamp = context.timestamp;
        const [currentDate] = timestamp.split("T");

        scheduleObject.map((date: string) => {
          const dateObj = new Date(date);
          const currentDateObj = new Date(currentDate);
          if (dateObj.getTime() < currentDateObj.getTime()) {
            addError(20006, `Holidays cannot be past ${currentDate}`);
          }
        });
      }
    } catch (e) {
      console.error("No Holiday", e);
    }

    try {
      console.info(`Mapping items with their respective providers`);
      const itemProviderMap: any = {};
      const providers = onSearchCatalog["bpp/providers"];
      providers.forEach((provider: any) => {
        const items = provider.items;
        const itemArray: any = [];
        items.forEach((item: any) => {
          itemArray.push(item.id);
        });
        itemProviderMap[provider.id] = itemArray;
      });

      await RedisService.setKey(
        `${transaction_id}_itemProviderMap`,
        JSON.stringify(itemProviderMap),
        TTL_IN_SECONDS
      );
    } catch (e: any) {
      console.error(
        `Error while mapping items with their respective providers ${e.stack}`
      );
    }

    try {
      console.info(`Storing Item IDs in /${constants.ON_SEARCH}`);
      const providers = onSearchCatalog["bpp/providers"];
      providers.forEach((provider: any, index: number) => {
        const items = provider.items;
        items.forEach((item: any, j: number) => {
          if (itemsId.has(item.id)) {
            addError(
              20005,
              `Duplicate item id: ${item.id} in bpp/providers[${index}]`
            );
          } else {
            itemsId.add(item.id);
          }
        });
      });
    } catch (error: any) {
      console.error(
        `Error while storing Item IDs in /${constants.ON_SEARCH}, ${error.stack}`
      );
    }

    try {
      console.info(`Checking for np_type in bpp/descriptor`);
      const descriptor = onSearchCatalog["bpp/descriptor"];
      descriptor?.tags.map(async (tag: { code: any; list: any[] }) => {
        if (tag.code === "bpp_terms") {
          const npType = tag.list.find((item) => item.code === "np_type");

          if (!npType) {
            addError(20006, `Missing np_type in bpp/descriptor`);
            await RedisService.setKey(
              `${transaction_id}_${ApiSequence.ON_SEARCH}np_type`,
              JSON.stringify(""),
              TTL_IN_SECONDS
            );
          } else {
            await RedisService.setKey(
              `${transaction_id}_${ApiSequence.ON_SEARCH}np_type`,
              npType.value,
              TTL_IN_SECONDS
            );
            const npTypeValue = npType.value.toUpperCase();
            if (npTypeValue !== "ISN" && npTypeValue !== "MSN") {
              addError(
                20006,
                `Invalid value '${npType.value}' for np_type. It should be either 'ISN' or 'MSN' in uppercase`
              );
            }
          }

          const accept_bap_terms = tag.list.find(
            (item) => item.code === "accept_bap_terms"
          );
          if (accept_bap_terms) {
            addError(
              20006,
              `remove accept_bap_terms block in /bpp/descriptor/tags; should be enabled once BNP send their static terms in /search and are later accepted by SNP`
            );
          }

          const collect_payment = tag.list.find(
            (item) => item.code === "collect_payment"
          );
          if (collect_payment) {
            addError(
              20006,
              `collect_payment is not required in bpp/descriptor/tags`
            );
          }
        }
      });
    } catch (error: any) {
      console.error(
        `Error while checking np_type in bpp/descriptor for /${constants.ON_SEARCH}, ${error.stack}`
      );
    }

    try {
      console.info(
        `Checking Providers info (bpp/providers) in /${constants.ON_SEARCH}`
      );
      let i = 0;
      const bppPrvdrs = onSearchCatalog["bpp/providers"];
      const len = bppPrvdrs.length;
      const tmpstmp = context.timestamp;
      let itemIdList: any = [];
      let itemsArray: any = [];
      while (i < len) {
        const categoriesId = new Set();
        const customGrpId = new Set();
        const seqSet = new Set();
        const itemCategory_id = new Set();
        const categoryRankSet = new Set();
        const prvdrLocationIds = new Set();

        console.info(
          `Validating uniqueness for provider id in bpp/providers[${i}]...`
        );
        const prvdr = bppPrvdrs[i];
        const categories = prvdr?.["categories"];
        const items = prvdr?.["items"];

        if (prvdrsId.has(prvdr.id)) {
          addError(
            20003,
            `Duplicate provider id: ${prvdr.id} in bpp/providers`
          );
        } else {
          prvdrsId.add(prvdr.id);
        }

        console.info(
          `Checking store enable/disable timestamp in bpp/providers[${i}]`
        );
        const providerTime = new Date(prvdr.time.timestamp).getTime();
        const contextTimestamp = new Date(tmpstmp).getTime();

        await RedisService.setKey(
          `${transaction_id}_${ApiSequence.ON_SEARCH}_tmpstmp`,
          JSON.stringify(context.timestamp),
          TTL_IN_SECONDS
        );

        if (providerTime > contextTimestamp) {
          addError(
            20006,
            `store enable/disable timestamp (/bpp/providers/time/timestamp) should be less then or equal to context.timestamp`
          );
        }

        try {
          const customGroupCategory = extractCustomGroups(categories);
          const baseTreeNodes = mapItemToTreeNode(items);
          const customItems = mapCustomItemToTreeNode(
            items,
            customGroupCategory
          );
          const mapItems = mapCustomizationsToBaseItems(
            baseTreeNodes,
            customItems
          );
          const default_selection = calculateDefaultSelectionPrice(mapItems);

          default_selection.forEach(
            ({
              base_item,
              default_selection_calculated,
              default_selection_actual,
            }: {
              base_item: string;
              default_selection_calculated: { min: number; max: number };
              default_selection_actual: { min: number; max: number };
            }) => {
              const calcMin = default_selection_calculated?.min;
              const calcMax = default_selection_calculated?.max;
              const actualMin = default_selection_actual?.min;
              const actualMax = default_selection_actual?.max;
          
              if (calcMin !== actualMin || calcMax !== actualMax) {
                addError(
                  20006,
                  `Provided default_selection calculated incorrectly for base_item "${base_item}". ` +
                  `Calculated: min=${calcMin}, max=${calcMax}. ` +
                  `Given: min=${actualMin}, max=${actualMax}`
                );
              } else {
                console.info(`Base item "${base_item}" values match. No error.`);
              }
            }
          );
        } catch (error: any) {
          addError(
            20006,
            `Error while Calculating Default Selection in /${constants.ON_SEARCH}, ${error.message}`
          );
          console.info(
            `Error while Calculating Default Selection in /${constants.ON_SEARCH}, ${error.stack}`
          );
        }

        try {
          console.info(
            `Checking length of strings provided in descriptor /${constants.ON_SEARCH}`
          );
          const descriptor = prvdr["descriptor"];
          const result = validateObjectString(descriptor);
          if (typeof result === "string" && result.length) {
            addError(20006, result);
          }
        } catch (error: any) {
          console.info(
            `Error while Checking length of strings provided in descriptor /${constants.ON_SEARCH}, ${error.stack}`
          );
        }

        try {
          console.info(`Checking for empty list arrays in tags`);
          const categories = prvdr["categories"];
          categories.forEach(
            (category: {
              id: string;
              parent_category_id: string;
              descriptor: { name: string };
              tags: any[];
            }) => {
              if (category.parent_category_id === category.id) {
                addError(
                  20006,
                  `/message/catalog/bpp/providers/categories/parent_category_id should not be the same as id in category '${category.descriptor.name}'`
                );
              }
              category.tags.forEach(
                (tag: { code: string; list: any[] }, index: number) => {
                  if (tag.list.length === 0) {
                    addError(
                      20006,
                      `Empty list array provided for tag '${tag.code}' in category '${category.descriptor.name}'`
                    );
                  }
                  if (tag.code === "display") {
                    tag.list.forEach(
                      (item: { code: string; value: string }) => {
                        if (
                          item.code === "rank" &&
                          parseInt(item.value) === 0
                        ) {
                          addError(
                            20006,
                            `display rank provided in /message/catalog/bpp/providers/categories (category:'${category?.descriptor?.name}) should not be zero ("0"), it should start from one ('1')`
                          );
                        }
                      }
                    );
                  }
                  if (tag.code === "config") {
                    tag.list.forEach(
                      (item: { code: string; value: string }) => {
                        if (item.code === "seq" && parseInt(item.value) === 0) {
                          addError(
                            20006,
                            `Seq value should start from 1 and not 0 in category '${category.descriptor.name}'`
                          );
                        }
                      }
                    );
                  }
                  if (tag.code === "type") {
                    tag.list.forEach(
                      (item: { code: string; value: string }) => {
                        if (item.code === "type") {
                          if (
                            (category.parent_category_id === "" ||
                              category.parent_category_id) &&
                            item.value === "custom_group"
                          ) {
                            if (category.parent_category_id) {
                              addError(
                                20006,
                                `parent_category_id should not have any value while type is ${item.value}`
                              );
                            }
                            addError(
                              20006,
                              `parent_category_id should not be present while type is ${item.value}`
                            );
                          } else if (
                            category.parent_category_id !== "" &&
                            (item.value === "custom_menu" ||
                              item.value === "variant_group")
                          ) {
                            if (category.parent_category_id) {
                              addError(
                                20006,
                                `parent_category_id should be empty string while type is ${item.value}`
                              );
                            }
                          } else if (
                            category.parent_category_id &&
                            (item.value === "custom_menu" ||
                              item.value === "variant_group")
                          ) {
                            if (category.parent_category_id) {
                              addError(
                                20006,
                                `parent_category_id should be empty string while type is ${item.value}`
                              );
                            }
                          }
                        }
                      }
                    );
                  }
                }
              );
            }
          );
        } catch (error: any) {
          console.error(
            `Error while checking empty list arrays in tags for /${constants.ON_SEARCH}, ${error.stack}`
          );
        }

        try {
          const items = prvdr.items;
          itemsArray.push(items);
          items.forEach((item: any) => {
            itemIdList.push(item.id);
          });
          await RedisService.setKey(
            `${transaction_id}_ItemList`,
            JSON.stringify(itemIdList),
            TTL_IN_SECONDS
          );
        } catch (error: any) {
          console.error(`Error while adding items in a list, ${error.stack}`);
        }

        console.info(`Checking store timings in bpp/providers[${i}]`);
        prvdr.locations.forEach((loc: any, iter: any) => {
          try {
            console.info(
              `Checking gps precision of store location in /bpp/providers[${i}]/locations[${iter}]`
            );
            const has = Object.prototype.hasOwnProperty;
            if (has.call(loc, "gps")) {
              if (!checkGpsPrecision(loc.gps)) {
                addError(
                  20006,
                  `/bpp/providers[${i}]/locations[${iter}]/gps coordinates must be specified with at least six decimal places of precision`
                );
              }
            }
          } catch (error) {
            console.error(
              `!!Error while checking gps precision of store location in /bpp/providers[${i}]/locations[${iter}]`,
              error
            );
          }

          if (prvdrLocId.has(loc.id)) {
            addError(
              20004,
              `Duplicate location id: ${loc.id} in /bpp/providers[${i}]/locations[${iter}]`
            );
          } else {
            prvdrLocId.add(loc.id);
          }
          prvdrLocationIds.add(loc?.id);
          console.info("Checking store days...");
          const days = loc.time.days.split(",");
          days.forEach((day: any) => {
            day = parseInt(day);
            if (isNaN(day) || day < 1 || day > 7) {
              addError(
                20006,
                `store days (bpp/providers[${i}]/locations[${iter}]/time/days) should be in the format ("1,2,3,4,5,6,7") where 1- Monday and 7- Sunday`
              );
            }
          });

          console.info("Checking fixed or split timings");
          if (
            loc.time.range &&
            (loc.time.schedule?.frequency || loc.time.schedule?.times)
          ) {
            addError(
              20006,
              `Either one of fixed (range) or split (frequency and times) timings should be provided in /bpp/providers[${i}]/locations[${iter}]/time`
            );
          }

          if (
            !loc.time.range &&
            (!loc.time.schedule.frequency || !loc.time.schedule.times)
          ) {
            addError(
              20006,
              `Either one of fixed timings (range) or split timings (both frequency and times) should be provided in /bpp/providers[${i}]/locations[${iter}]/time`
            );
          }

          if ("range" in loc.time) {
            console.info("checking range (fixed timings) start and end");
            const startTime: any =
              "start" in loc.time.range ? parseInt(loc.time.range.start) : "";
            const endTime: any =
              "end" in loc.time.range ? parseInt(loc.time.range.end) : "";
            if (
              isNaN(startTime) ||
              isNaN(endTime) ||
              startTime > endTime ||
              endTime > 2359
            ) {
              addError(
                20006,
                `end time must be greater than start time in fixed timings /locations/time/range (fixed store timings)`
              );
            }
          }
        });

        try {
          const items = prvdr.items;
          items.forEach((item: any) => {
            itemIdList.push(item.id);
          });
          await RedisService.setKey(
            `${transaction_id}_ItemList`,
            JSON.stringify(itemIdList),
            TTL_IN_SECONDS
          );
        } catch (error: any) {
          console.error(`Error while adding items in a list, ${error.stack}`);
        }

        try {
          console.info(
            `Checking categories for provider (${prvdr.id}) in bpp/providers[${i}]`
          );
          let j = 0;
          const categories = onSearchCatalog["bpp/providers"][i]["categories"];
          if (!categories || !categories.length) {
            addError(
              20006,
              `Support for variants is mandatory, categories must be present in bpp/providers[${i}]`
            );
          }
          const iLen = categories.length;
          while (j < iLen) {
            console.info(
              `Validating uniqueness for categories id in bpp/providers[${i}].items[${j}]...`
            );
            const category = categories[j];

            const fulfillments =
              onSearchCatalog["bpp/providers"][i]["fulfillments"];
            const phoneNumber = fulfillments[i]?.contact?.phone;

            if (phoneNumber && !isValidPhoneNumber(phoneNumber)) {
              addError(
                20006,
                `Please enter a valid phone number consisting of 10 or 11 digits without any spaces or special characters in bpp/providers[${i}]/fulfillments[${i}]`
              );
            }

            if (categoriesId.has(category.id)) {
              addError(
                20006,
                `Duplicate category id: ${category.id} in bpp/providers[${i}]`
              );
            } else {
              categoriesId.add(category.id);
            }

            try {
              category.tags.map(
                (tag: { code: any; list: any[] }, index: number) => {
                  switch (tag.code) {
                    case "type":
                      const codeList = tag.list.find(
                        (item) => item.code === "type"
                      );
                      if (
                        !(
                          codeList.value === "custom_menu" ||
                          codeList.value === "custom_group" ||
                          codeList.value === "variant_group"
                        )
                      ) {
                        addError(
                          20006,
                          `list.code == type then value should be one of 'custom_menu','custom_group' and 'variant_group' in bpp/providers[${i}]`
                        );
                      }

                      if (codeList.value === "custom_group") {
                        customGrpId.add(category.id);
                      }
                      break;
                    case "timing":
                      for (const item of tag.list) {
                        switch (item.code) {
                          case "day_from":
                          case "day_to":
                            const dayValue = parseInt(item.value);
                            if (
                              isNaN(dayValue) ||
                              dayValue < 1 ||
                              dayValue > 7 ||
                              !/^-?\d+(\.\d+)?$/.test(item.value)
                            ) {
                              addError(
                                20006,
                                `Invalid value for '${item.code}': ${item.value}`
                              );
                            }
                            break;
                          case "time_from":
                          case "time_to":
                            if (!/^([01]\d|2[0-3])[0-5]\d$/.test(item.value)) {
                              addError(
                                20006,
                                `Invalid time format for '${item.code}': ${item.value}`
                              );
                            }
                            break;
                          default:
                            addError(
                              20006,
                              `Invalid list.code for 'timing': ${item.code}`
                            );
                        }
                      }

                      const dayFromItem = tag.list.find(
                        (item: any) => item.code === "day_from"
                      );
                      const dayToItem = tag.list.find(
                        (item: any) => item.code === "day_to"
                      );
                      const timeFromItem = tag.list.find(
                        (item: any) => item.code === "time_from"
                      );
                      const timeToItem = tag.list.find(
                        (item: any) => item.code === "time_to"
                      );

                      if (
                        dayFromItem &&
                        dayToItem &&
                        timeFromItem &&
                        timeToItem
                      ) {
                        const dayFrom = parseInt(dayFromItem.value, 10);
                        const dayTo = parseInt(dayToItem.value, 10);
                        const timeFrom = parseInt(timeFromItem.value, 10);
                        const timeTo = parseInt(timeToItem.value, 10);

                        if (dayTo < dayFrom) {
                          addError(
                            20006,
                            "'day_to' must be greater than or equal to 'day_from'"
                          );
                        }

                        if (timeTo <= timeFrom) {
                          addError(
                            20006,
                            "'time_to' must be greater than 'time_from'"
                          );
                        }
                      }
                      break;
                    case "display":
                      for (const item of tag.list) {
                        if (
                          item.code !== "rank" ||
                          !/^-?\d+(\.\d+)?$/.test(item.value)
                        ) {
                          addError(
                            20006,
                            `Invalid value for 'display': ${item.value}`
                          );
                        } else {
                          if (categoryRankSet.has(category.id)) {
                            addError(
                              20006,
                              `Duplicate rank in category id: ${category.id} in bpp/providers[${i}]`
                            );
                          } else {
                            categoryRankSet.add(category.id);
                          }
                        }
                      }
                      break;
                    case "config":
                      const minItem: any = tag.list.find(
                        (item: { code: string }) => item.code === "min"
                      );
                      const maxItem: any = tag.list.find(
                        (item: { code: string }) => item.code === "max"
                      );
                      const inputItem: any = tag.list.find(
                        (item: { code: string }) => item.code === "input"
                      );
                      const seqItem: any = tag.list.find(
                        (item: { code: string }) => item.code === "seq"
                      );

                      if (!minItem || !maxItem) {
                        addError(
                          20006,
                          `Both 'min' and 'max' values are required in 'config' at index: ${j}`
                        );
                      }

                      if (!/^-?\d+(\.\d+)?$/.test(minItem?.value)) {
                        addError(
                          20006,
                          `Invalid value for ${minItem.code}: ${minItem.value} at index: ${j}`
                        );
                      }

                      if (!/^-?\d+(\.\d+)?$/.test(maxItem?.value)) {
                        addError(
                          20006,
                          `Invalid value for ${maxItem.code}: ${maxItem.value} at index: ${j}`
                        );
                      }

                      if (!/^-?\d+(\.\d+)?$/.test(seqItem?.value)) {
                        addError(
                          20006,
                          `Invalid value for ${seqItem.code}: ${seqItem.value} at index: ${j}`
                        );
                      }

                      const inputEnum = ["select", "text"];
                      if (!inputEnum.includes(inputItem?.value)) {
                        addError(
                          20006,
                          `Invalid value for 'input': ${inputItem.value}, it should be one of ${inputEnum} at index: ${j}`
                        );
                      }
                      break;
                  }
                }
              );
              console.info(`Category '${category.descriptor.name}' is valid.`);
            } catch (error: any) {
              console.error(
                `Validation error for category '${category.descriptor.name}': ${error.message}`
              );
            }

            j++;
          }
        } catch (error: any) {
          console.error(
            `!!Errors while checking categories in bpp/providers[${i}], ${error.stack}`
          );
        }

        try {
          console.info(
            `Checking items for provider (${prvdr.id}) in bpp/providers[${i}]`
          );
          let j = 0;
          const items = onSearchCatalog["bpp/providers"][i]["items"];
          const iLen = items.length;
          while (j < iLen) {
            console.info(
              `Validating uniqueness for item id in bpp/providers[${i}].items[${j}]...`
            );
            const item = items[j];

            if ("category_id" in item) {
              itemCategory_id.add(item.category_id);
            }

            if ("category_ids" in item) {
              item[`category_ids`].map((category: string, index: number) => {
                const categoryId = category.split(":")[0];
                const seq = category.split(":")[1];

                const seqExists = item[`category_ids`].some(
                  (cat: any) => cat.seq === seq
                );
                if (seqExists) {
                  addError(
                    20006,
                    `Duplicate seq: ${seq} in category_ids in prvdr${i}item${j}`
                  );
                } else {
                  seqSet.add(seq);
                }

                if (!categoriesId.has(categoryId)) {
                  addError(
                    20006,
                    `item${j} should have category_ids one of the Catalog/categories/id`
                  );
                }
              });
            }

            let lower_and_upper_not_present: boolean = true;
            let default_selection_not_present: boolean = true;
            try {
              console.info(
                `Checking selling price and maximum price for item id: ${item.id}`
              );
              if ("price" in item) {
                const sPrice = parseFloat(item.price.value);
                const maxPrice = parseFloat(item.price.maximum_value);

                const lower = parseFloat(item.price?.tags?.[0].list[0]?.value);
                const upper = parseFloat(item.price?.tags?.[0].list[1]?.value);

                if (lower >= 0 && upper >= 0) {
                  lower_and_upper_not_present = false;
                }

                const default_selection_value = parseFloat(
                  item.price?.tags?.[1].list[0]?.value
                );
                const default_selection_max_value = parseFloat(
                  item.price?.tags?.[1].list[1]?.value
                );

                if (
                  default_selection_value >= 0 &&
                  default_selection_max_value >= 0
                ) {
                  default_selection_not_present = false;
                }

                if (sPrice > maxPrice) {
                  addError(
                    20006,
                    `selling price of item /price/value with id: (${item.id}) can't be greater than the maximum price /price/maximum_value in /bpp/providers[${i}]/items[${j}]`
                  );
                }

                if (upper < lower) {
                  addError(
                    20006,
                    `selling lower range: ${lower} of code: range with id: (${item.id}) can't be greater than the upper range: ${upper}`
                  );
                }

                if (default_selection_max_value < default_selection_value) {
                  addError(
                    20006,
                    `value: ${default_selection_value} of code: default_selection with id: (${item.id}) can't be greater than the maximum_value: ${default_selection_max_value}`
                  );
                }
              }
            } catch (e: any) {
              console.error(
                `Error while checking selling price and maximum price for item id: ${item.id}, ${e.stack}`
              );
            }

            try {
              console.info(`Checking fulfillment_id for item id: ${item.id}`);
              if (
                item.fulfillment_id &&
                !onSearchFFIdsArray[i].has(item.fulfillment_id)
              ) {
                addError(
                  20006,
                  `fulfillment_id in /bpp/providers[${i}]/items[${j}] should map to one of the fulfillments id in bpp/prvdr${i}/fulfillments`
                );
              }
            } catch (e: any) {
              console.error(
                `Error while checking fulfillment_id for item id: ${item.id}, ${e.stack}`
              );
            }

            try {
              console.info(`Checking location_id for item id: ${item.id}`);
              if (item.location_id && !prvdrLocId.has(item.location_id)) {
                addError(
                  20006,
                  `location_id in /bpp/providers[${i}]/items[${j}] should be one of the locations id in /bpp/providers[${i}]/locations`
                );
              }
            } catch (e: any) {
              console.error(
                `Error while checking location_id for item id: ${item.id}, ${e.stack}`
              );
            }

            try {
              console.info(
                `Checking consumer care details for item id: ${item.id}`
              );
              if ("@ondc/org/contact_details_consumer_care" in item) {
                let consCare = item["@ondc/org/contact_details_consumer_care"];
                consCare = consCare.split(",");
                if (consCare.length < 3) {
                  addError(
                    20006,
                    `@ondc/org/contact_details_consumer_care should be in the format "name,email,contactno" in /bpp/providers[${i}]/items`
                  );
                } else {
                  const checkEmail: boolean = emailRegex(consCare[1].trim());
                  if (isNaN(consCare[2].trim()) || !checkEmail) {
                    addError(
                      20006,
                      `@ondc/org/contact_details_consumer_care should be in the format "name,email,contactno" in /bpp/providers[${i}]/items`
                    );
                  }
                }
              }
            } catch (e: any) {
              console.error(
                `Error while checking consumer care details for item id: ${item.id}, ${e.stack}`
              );
            }

            try {
              item.tags.map(
                (tag: { code: any; list: any[] }, index: number) => {
                  switch (tag.code) {
                    case "type":
                      if (
                        tag.list &&
                        Array.isArray(tag.list) &&
                        tag.list.some(
                          (listItem: { code: string; value: string }) =>
                            listItem.code === "type" &&
                            listItem.value === "item"
                        )
                      ) {
                        if (!item.time) {
                          addError(
                            20006,
                            `item_id: ${item.id} should contain time object in bpp/providers[${i}]`
                          );
                        }

                        if (!item.category_ids) {
                          addError(
                            20006,
                            `item_id: ${item.id} should contain category_ids in bpp/providers[${i}]`
                          );
                        }
                      }
                      break;

                    case "custom_group":
                      tag.list.map(
                        (
                          it: { code: string; value: string },
                          index: number
                        ) => {
                          if (!customGrpId.has(it.value)) {
                            addError(
                              20006,
                              `item_id: ${item.id} should have custom_group_id one of the ids passed in categories bpp/providers[${i}]`
                            );
                          }
                        }
                      );
                      break;

                    case "config":
                      const idList: any = tag.list.find(
                        (item: { code: string }) => item.code === "id"
                      );
                      const minList: any = tag.list.find(
                        (item: { code: string }) => item.code === "min"
                      );
                      const maxList: any = tag.list.find(
                        (item: { code: string }) => item.code === "max"
                      );
                      const seqList: any = tag.list.find(
                        (item: { code: string }) => item.code === "seq"
                      );

                      if (!categoriesId.has(idList.value)) {
                        addError(
                          20006,
                          `value in catalog/items${j}/tags${index}/config/list/ should be one of the catalog/category/ids`
                        );
                      }

                      if (!/^-?\d+(\.\d+)?$/.test(minList.value)) {
                        addError(
                          20006,
                          `Invalid value for ${minList.code}: ${minList.value}`
                        );
                      }

                      if (!/^-?\d+(\.\d+)?$/.test(maxList.value)) {
                        addError(
                          20006,
                          `Invalid value for ${maxList.code}: ${maxList.value}`
                        );
                      }

                      if (!/^-?\d+(\.\d+)?$/.test(seqList.value)) {
                        addError(
                          20006,
                          `Invalid value for ${seqList.code}: ${seqList.value}`
                        );
                      }
                      break;

                    case "timing":
                      for (const item of tag.list) {
                        switch (item.code) {
                          case "day_from":
                          case "day_to":
                            const dayValue = parseInt(item.value);
                            if (
                              isNaN(dayValue) ||
                              dayValue < 1 ||
                              dayValue > 5 ||
                              !/^-?\d+(\.\d+)?$/.test(item.value)
                            ) {
                              addError(
                                20006,
                                `Invalid value for '${item.code}': ${item.value}`
                              );
                            }
                            break;
                          case "time_from":
                          case "time_to":
                            if (!/^([01]\d|2[0-3])[0-5]\d$/.test(item.value)) {
                              addError(
                                20006,
                                `Invalid time format for '${item.code}': ${item.value}`
                              );
                            }
                            break;
                          default:
                            addError(
                              20006,
                              `Invalid list.code for 'timing': ${item.code}`
                            );
                        }
                      }

                      const dayFromItem = tag.list.find(
                        (item: any) => item.code === "day_from"
                      );
                      const dayToItem = tag.list.find(
                        (item: any) => item.code === "day_to"
                      );
                      const timeFromItem = tag.list.find(
                        (item: any) => item.code === "time_from"
                      );
                      const timeToItem = tag.list.find(
                        (item: any) => item.code === "time_to"
                      );

                      if (
                        dayFromItem &&
                        dayToItem &&
                        timeFromItem &&
                        timeToItem
                      ) {
                        const dayFrom = parseInt(dayFromItem.value, 10);
                        const dayTo = parseInt(dayToItem.value, 10);
                        const timeFrom = parseInt(timeFromItem.value, 10);
                        const timeTo = parseInt(timeToItem.value, 10);

                        if (dayTo < dayFrom) {
                          addError(
                            20006,
                            "'day_to' must be greater than or equal to 'day_from'"
                          );
                        }

                        if (timeTo <= timeFrom) {
                          addError(
                            20006,
                            "'time_to' must be greater than 'time_from'"
                          );
                        }
                      }
                      break;

                    case "veg_nonveg":
                      const allowedCodes = ["veg", "non_veg", "egg"];
                      for (const it of tag.list) {
                        if (it.code && !allowedCodes.includes(it.code)) {
                          addError(
                            20006,
                            `item_id: ${item.id} should have veg_nonveg one of the 'veg', 'non_veg' or 'egg' in bpp/providers[${i}]`
                          );
                        }
                      }
                      break;
                  }
                }
              );
            } catch (e: any) {
              console.error(
                `Error while checking tags for item id: ${item.id}, ${e.stack}`
              );
            }

            try {
              console.info(`Checking offers.tags under bpp/providers`);
              const offers =
                onSearchCatalog["bpp/providers"][i]?.offers ?? null;
              if (offers) {
                offers.forEach((offer: any, offerIndex: number) => {
                  const tags = offer.tags;

                  if (!tags || !Array.isArray(tags)) {
                    addError(
                      20006,
                      `Tags must be provided for offers[${offerIndex}] with descriptor code '${offer.descriptor?.code}'`
                    );
                    return;
                  }

                  switch (offer.descriptor?.code) {
                    case "discount":
                      const qualifierDiscount = tags.find(
                        (tag: any) => tag.code === "qualifier"
                      );
                      if (
                        !qualifierDiscount ||
                        !qualifierDiscount.list.some(
                          (item: any) => item.code === "min_value"
                        )
                      ) {
                        addError(
                          20006,
                          `'qualifier' tag must include 'min_value' for offers[${offerIndex}] when offer.descriptor.code = ${offer.descriptor.code}`
                        );
                      }

                      const benefitDiscount = tags.find(
                        (tag: any) => tag.code === "benefit"
                      );
                      if (
                        !benefitDiscount ||
                        !benefitDiscount.list.some(
                          (item: any) => item.code === "value"
                        ) ||
                        !benefitDiscount.list.some(
                          (item: any) => item.code === "value_type"
                        )
                      ) {
                        addError(
                          20006,
                          `'benefit' tag must include both 'value' and 'value_type' for offers[${offerIndex}] when offer.descriptor.code = ${offer.descriptor.code}`
                        );
                      }
                      break;

                    case "buyXgetY":
                      const qualifierBuyXgetY = tags.find(
                        (tag: any) => tag.code === "qualifier"
                      );
                      if (
                        !qualifierBuyXgetY ||
                        !qualifierBuyXgetY.list.some(
                          (item: any) => item.code === "item_count"
                        )
                      ) {
                        addError(
                          20006,
                          `'qualifier' tag must include 'item_count' for offers[${offerIndex}] when offer.descriptor.code = ${offer.descriptor.code}`
                        );
                      }

                      const benefitBuyXgetY = tags.find(
                        (tag: any) => tag.code === "benefit"
                      );
                      if (
                        !benefitBuyXgetY ||
                        !benefitBuyXgetY.list.some(
                          (item: any) => item.code === "item_count"
                        )
                      ) {
                        addError(
                          20006,
                          `'benefit' tag must include 'item_count' for offers[${offerIndex}] when offer.descriptor.code = ${offer.descriptor.code}`
                        );
                      }
                      break;

                    case "freebie":
                      const qualifierFreebie = tags.find(
                        (tag: any) => tag.code === "qualifier"
                      );
                      if (
                        !qualifierFreebie ||
                        !qualifierFreebie.list.some(
                          (item: any) => item.code === "min_value"
                        )
                      ) {
                        addError(
                          20006,
                          `'qualifier' tag must include 'min_value' for offers[${offerIndex}] when offer.descriptor.code = ${offer.descriptor.code}`
                        );
                      }

                      const benefitFreebie = tags.find(
                        (tag: any) => tag.code === "benefit"
                      );
                      if (
                        !benefitFreebie ||
                        !benefitFreebie.list.some(
                          (item: any) => item.code === "item_count"
                        ) ||
                        !benefitFreebie.list.some(
                          (item: any) => item.code === "item_id"
                        ) ||
                        !benefitFreebie.list.some(
                          (item: any) => item.code === "item_value"
                        )
                      ) {
                        addError(
                          20006,
                          `'benefit' tag must include 'item_count', 'item_id', and 'item_value' for offers[${offerIndex}] when offer.descriptor.code = ${offer.descriptor.code}`
                        );
                      }
                      break;

                    case "slab":
                      const qualifierSlab = tags.find(
                        (tag: any) => tag.code === "qualifier"
                      );
                      if (
                        !qualifierSlab ||
                        !qualifierSlab.list.some(
                          (item: any) => item.code === "min_value"
                        )
                      ) {
                        addError(
                          20006,
                          `'qualifier' tag must include 'min_value' for offers[${offerIndex}] when offer.descriptor.code = ${offer.descriptor.code}`
                        );
                      }

                      const benefitSlab = tags.find(
                        (tag: any) => tag.code === "benefit"
                      );
                      if (
                        !benefitSlab ||
                        !benefitSlab.list.some(
                          (item: any) => item.code === "value"
                        ) ||
                        !benefitSlab.list.some(
                          (item: any) => item.code === "value_type"
                        ) ||
                        !benefitSlab.list.some(
                          (item: any) => item.code === "value_cap"
                        )
                      ) {
                        addError(
                          20006,
                          `'benefit' tag must include 'value', 'value_type', and 'value_cap' for offers[${offerIndex}] when offer.descriptor.code = ${offer.descriptor.code}`
                        );
                      }
                      break;

                    case "combo":
                      const qualifierCombo = tags.find(
                        (tag: any) => tag.code === "qualifier"
                      );
                      if (
                        !qualifierCombo ||
                        !qualifierCombo.list.some(
                          (item: any) => item.code === "min_value"
                        ) ||
                        !qualifierCombo.list.some(
                          (item: any) => item.code === "item_id"
                        )
                      ) {
                        addError(
                          20006,
                          `'qualifier' tag must include 'min_value' and 'item_id' for offers[${offerIndex}] when offer.descriptor.code = ${offer.descriptor.code}`
                        );
                      }

                      const benefitCombo = tags.find(
                        (tag: any) => tag.code === "benefit"
                      );
                      if (
                        !benefitCombo ||
                        !benefitCombo.list.some(
                          (item: any) => item.code === "value"
                        ) ||
                        !benefitCombo.list.some(
                          (item: any) => item.code === "value_type"
                        ) ||
                        !benefitCombo.list.some(
                          (item: any) => item.code === "value_cap"
                        )
                      ) {
                        addError(
                          20006,
                          `'benefit' tag must include 'value', 'value_type', and 'value_cap' for offers[${offerIndex}] when offer.descriptor.code = ${offer.descriptor.code}`
                        );
                      }
                      break;

                    case "delivery":
                      const qualifierDelivery = tags.find(
                        (tag: any) => tag.code === "qualifier"
                      );
                      if (
                        !qualifierDelivery ||
                        !qualifierDelivery.list.some(
                          (item: any) => item.code === "min_value"
                        )
                      ) {
                        addError(
                          20006,
                          `'qualifier' tag must include 'min_value' for offers[${offerIndex}] when offer.descriptor.code = ${offer.descriptor.code}`
                        );
                      }

                      const benefitDelivery = tags.find(
                        (tag: any) => tag.code === "benefit"
                      );
                      if (
                        !benefitDelivery ||
                        !benefitDelivery.list.some(
                          (item: any) => item.code === "value"
                        ) ||
                        !benefitDelivery.list.some(
                          (item: any) => item.code === "value_type"
                        ) ||
                        !benefitDelivery.list.some(
                          (item: any) => item.code === "value_cap"
                        )
                      ) {
                        addError(
                          20006,
                          `'benefit' tag must include 'value', 'value_type', and 'value_cap' for offers[${offerIndex}] when offer.descriptor.code = ${offer.descriptor.code}`
                        );
                      }
                      break;

                    default:
                      console.info(
                        `No specific validation required for offer type: ${offer.descriptor?.code}`
                      );
                  }
                });
              }
            } catch (error: any) {
              console.error(
                `Error while checking offers.tags under bpp/providers: ${error.stack}`
              );
            }

            try {
              console.info(`Validating item tags`);
              const itemTypeTag = item.tags.find(
                (tag: { code: string }) => tag.code === "type"
              );
              const customGroupTag = item.tags.find(
                (tag: { code: string }) => tag.code === "custom_group"
              );
              if (
                itemTypeTag &&
                itemTypeTag.list.length > 0 &&
                itemTypeTag.list[0].value === "item" &&
                !customGroupTag
              ) {
                addError(
                  20006,
                  `/message/catalog/bpp/providers/items/tags/'type' is optional for non-customizable (standalone) SKUs`
                );
              } else if (
                itemTypeTag &&
                itemTypeTag.list.length > 0 &&
                itemTypeTag.list[0].value === "item" &&
                customGroupTag
              ) {
                if (default_selection_not_present) {
                  addError(
                    20006,
                    `/message/catalog/bpp/providers/items must have default_selection price for customizable items`
                  );
                }
                if (lower_and_upper_not_present) {
                  addError(
                    20006,
                    `/message/catalog/bpp/providers/items must have lower/upper range for customizable items`
                  );
                }
              }
            } catch (error: any) {
              console.error(`Error while validating item, ${error.stack}`);
            }

            try {
              console.info(`Validating default customizations`);
              const itemTypeTag = item.tags.find(
                (tag: any) =>
                  tag.code === "type" &&
                  tag.list.some(
                    (item: any) =>
                      item.code === "type" && item.value === "customization"
                  )
              );
              if (itemTypeTag) {
                const parentTag = item.tags.find(
                  (tag: any) => tag.code === "parent"
                );
                if (parentTag) {
                  const categoryId = parentTag.list.find(
                    (item: any) => item.code === "id"
                  )?.value;
                  if (categoryId) {
                    const category = categories.find(
                      (category: any) => category.id === categoryId
                    );
                    if (category) {
                      const configTag = category.tags.find(
                        (tag: any) => tag.code === "config"
                      );
                      if (configTag) {
                        const minSelection = configTag.list.find(
                          (item: any) => item.code === "min"
                        )?.value;
                        if (minSelection === "0") {
                          const defaultTag = parentTag.list.find(
                            (item: any) => item.code === "default"
                          );
                          if (defaultTag && defaultTag.value === "yes") {
                            addError(
                              20006,
                              `Default customization should not be set true for a custom_group where min selection is 0`
                            );
                          }
                        }
                      }
                    }
                  }
                }
              }
            } catch (error: any) {
              console.error(
                `Error while validating default customizations, ${error.stack}`
              );
            }

            j++;
          }
        } catch (error: any) {
          console.error(
            `!!Errors while checking items in bpp/providers[${i}], ${error.stack}`
          );
        }

        try {
          const providers = payload.message.catalog["bpp/providers"];
          const address = providers[0].locations[0].address;

          if (address) {
            const area_code = Number.parseInt(address.area_code);
            const std = context.city.split(":")[1];

            console.info(
              `Comparing area_code and STD Code for /${constants.ON_SEARCH}`
            );
            const areaWithSTD = compareSTDwithArea(area_code, std);

            if (!areaWithSTD) {
              addError(
                20006,
                `STD code does not match with correct area_code on /${constants.ON_SEARCH}`
              );
            }
          }
        } catch (error: any) {
          console.error(
            `Error while matching area_code and std code for /${constants.SEARCH} and /${constants.ON_SEARCH} api, ${error.stack}`
          );
        }

        try {
          console.info(
            `Comparing valid timestamp in context.timestamp and bpp/providers/items/time/timestamp`
          );
          const timestamp = context.timestamp;
          for (let i in onSearchCatalog["bpp/providers"]) {
            const items = onSearchCatalog["bpp/providers"][i].items;
            items.forEach((item: any, index: number) => {
              if (item?.time) {
                const itemTimeStamp = item.time.timestamp;
                const op = areTimestampsLessThanOrEqualTo(
                  itemTimeStamp,
                  timestamp
                );
                if (!op) {
                  addError(
                    20006,
                    `Timestamp for item[${index}] can't be greater than context.timestamp`
                  );
                }
              }
            });
          }
        } catch (error: any) {
          console.error(
            `!!Errors while checking timestamp in context.timestamp and bpp/providers/items/time/timestamp, ${error.stack}`
          );
        }

        try {
          console.info(
            `Checking for tags array in message/catalog/bpp/providers[0]/categories[0]/tags`
          );
          const categories = message.catalog["bpp/providers"][i].categories;
          categories.forEach((item: any) => {
            const tags = item.tags;
            if (tags.length < 1) {
              addError(
                20006,
                `/message/catalog/bpp/providers[${i}]/categories cannot have tags as an empty array`
              );
            }
          });
        } catch (error: any) {
          console.error(
            `Error while checking tags array in message/catalog/bpp/providers[${i}]/categories`
          );
        }

        try {
          let customMenus = [];
          customMenus = categories.filter((category: any) =>
            category.tags.some(
              (tag: any) =>
                tag.code === "type" &&
                tag.list.some((type: any) => type.value === "custom_menu")
            )
          );

          if (customMenus.length > 0) {
            customMenu = true;

            const ranks = customMenus.map((cstmMenu: any) =>
              parseInt(
                cstmMenu.tags
                  .find((tag: any) => tag.code === "display")
                  .list.find((display: any) => display.code === "rank").value
              )
            );

            const hasDuplicates = ranks.length !== new Set(ranks).size;
            const missingRanks = [...Array(Math.max(...ranks)).keys()]
              .map((i) => i + 1)
              .filter((rank) => !ranks.includes(rank));

            if (hasDuplicates) {
              addError(
                20006,
                `Duplicate ranks found, ${ranks} in providers${i}/categories`
              );
            } else if (missingRanks.length > 0) {
              addError(
                20006,
                `Missing ranks: ${missingRanks} in providers${i}/categories`
              );
            } else {
              const sortedCustomMenus = customMenus.sort((a: any, b: any) => {
                const rankA = parseInt(
                  a.tags
                    .find((tag: any) => tag.code === "display")
                    .list.find((display: any) => display.code === "rank").value
                );
                const rankB = parseInt(
                  b.tags
                    .find((tag: any) => tag.code === "display")
                    .list.find((display: any) => display.code === "rank").value
                );
                return rankA - rankB;
              });

              customMenuIds = sortedCustomMenus.map((item: any) => item.id);
            }
          }
        } catch (error: any) {
          console.error(
            `!!Errors while checking rank in bpp/providers[${i}].category.tags, ${error.stack}`
          );
        }
        if (customMenu) {
          try {
            const categoryMap: Record<string, number[]> = {};
            onSearchCatalog["bpp/providers"][i]["items"].forEach(
              (item: any) => {
                if (item?.category_ids) {
                  item?.category_ids?.forEach((category_id: any) => {
                    const [category, sequence] = category_id
                      .split(":")
                      .map(Number);
                    if (!categoryMap[category]) {
                      categoryMap[category] = [];
                    }
                    categoryMap[category].push(sequence);
                  });

                  Object.keys(categoryMap).forEach((category) => {
                    categoryMap[category].sort((a, b) => a - b);
                  });
                }
              }
            );
            let countSeq = 0;

            customMenuIds.map((category_id: any) => {
              const categoryArray = categoryMap[`${category_id}`];
              if (!categoryArray) {
                addError(
                  20006,
                  `No items are mapped with the given category_id ${category_id} in providers${i}/items`
                );
              } else {
                let i = 0;
                while (i < categoryArray.length) {
                  countSeq++;
                  const exist = categoryArray.includes(countSeq);
                  if (!exist) {
                    addError(
                      20006,
                      `The given sequence ${countSeq} doesn't exist with the given category_id ${category_id} in providers${i}/items according to the rank`
                    );
                  }
                  i++;
                }
              }
            });
          } catch (error: any) {
            console.error(
              `!!Errors while checking category_ids in the items, ${error.stack}`
            );
          }
        }

        try {
          console.info(
            `Checking image array for bpp/provider/categories/descriptor/images[]`
          );
          for (let i in onSearchCatalog["bpp/providers"]) {
            const categories = onSearchCatalog["bpp/providers"][i].categories;
            categories.forEach((item: any, index: number) => {
              if (item.descriptor.images && item.descriptor.images.length < 1) {
                addError(
                  20006,
                  `Images should not be provided as empty array for categories[${index}]/descriptor`
                );
              }
            });
          }
        } catch (error: any) {
          console.error(
            `!!Errors while checking image array for bpp/providers/[]/categories/[]/descriptor/images[], ${error.stack}`
          );
        }

        try {
          console.info(
            `Checking serviceability construct for bpp/providers[${i}]`
          );
          const tags = onSearchCatalog["bpp/providers"][i]["tags"];
          if (!tags || !tags.length) {
            addError(20006, `tags must be present in bpp/providers[${i}]`);
          }
          if (tags) {
            const circleRequired = checkServiceabilityType(tags);
            if (circleRequired) {
              const errors: Record<string, string> = validateLocations(
                message.catalog["bpp/providers"][i].locations,
                tags
              );
              Object.keys(errors).forEach((key) =>
                addError(20006, errors[key])
              );
            }
          }
          const serviceabilitySet = new Set();
          const timingSet = new Set();
          tags.forEach((sc: any, t: any) => {
            if (sc.code === "serviceability") {
              if (serviceabilitySet.has(JSON.stringify(sc))) {
                addError(
                  20006,
                  `serviceability construct /bpp/providers[${i}]/tags[${t}] should not be same with the previous serviceability constructs`
                );
              }

              serviceabilitySet.add(JSON.stringify(sc));
              if ("list" in sc) {
                if (sc.list.length != 5) {
                  addError(
                    20006,
                    `serviceability construct /bpp/providers[${i}]/tags[${t}] should be defined as per the API contract`
                  );
                }

                const loc =
                  sc.list.find((elem: any) => elem.code === "location") || "";
                if (!loc) {
                  addError(
                    20006,
                    `serviceability construct /bpp/providers[${i}]/tags[${t}] should be defined as per the API contract (location is missing)`
                  );
                } else {
                  if ("value" in loc) {
                    if (!prvdrLocId.has(loc.value)) {
                      addError(
                        20006,
                        `location in serviceability construct should be one of the location ids bpp/providers[${i}]/locations`
                      );
                    }
                  } else {
                    addError(
                      20006,
                      `serviceability construct /bpp/providers[${i}]/tags[${t}] should be defined as per the API contract (location is missing)`
                    );
                  }
                }

                const ctgry =
                  sc.list.find((elem: any) => elem.code === "category") || "";
                if (!ctgry) {
                  addError(
                    20006,
                    `serviceability construct /bpp/providers[${i}]/tags[${t}] should be defined as per the API contract (category is missing)`
                  );
                } else {
                  if ("value" in ctgry) {
                    if (!itemCategory_id.has(ctgry.value)) {
                      addError(
                        20006,
                        `category in serviceability construct should be one of the category ids bpp/providers[${i}]/items/category_id`
                      );
                    }
                  } else {
                    addError(
                      20006,
                      `serviceability construct /bpp/providers[${i}]/tags[${t}] should be defined as per the API contract (category is missing)`
                    );
                  }
                }

                const type =
                  sc.list.find((elem: any) => elem.code === "type") || "";
                if (!type) {
                  addError(
                    20006,
                    `serviceability construct /bpp/providers[${i}]/tags[${t}] should be defined as per the API contract (type is missing)`
                  );
                } else {
                  if ("value" in type) {
                    switch (type.value) {
                      case "10":
                        {
                          const val =
                            sc.list.find((elem: any) => elem.code === "val") ||
                            "";
                          if ("value" in val) {
                            if (isNaN(val.value)) {
                              addError(
                                20006,
                                `value should be a number (code:"val") for type 10 (hyperlocal) in /bpp/providers[${i}]/tags[${t}]`
                              );
                            }
                          } else {
                            addError(
                              20006,
                              `serviceability construct /bpp/providers[${i}]/tags[${t}] should be defined as per the API contract (value is missing for code "val")`
                            );
                          }

                          const unit =
                            sc.list.find((elem: any) => elem.code === "unit") ||
                            "";
                          if ("value" in unit) {
                            if (unit.value != "km") {
                              addError(
                                20006,
                                `value should be "km" (code:"unit") for type 10 (hyperlocal) in /bpp/providers[${i}]/tags[${t}]`
                              );
                            }
                          } else {
                            addError(
                              20006,
                              `serviceability construct /bpp/providers[${i}]/tags[${t}] should be defined as per the API contract (value is missing for code "unit")`
                            );
                          }
                        }
                        break;
                      case "11":
                        {
                          const val =
                            sc.list.find((elem: any) => elem.code === "val") ||
                            "";
                          if ("value" in val) {
                            const pincodes = val.value.split(/,|-/);
                            pincodes.forEach((pincode: any) => {
                              if (isNaN(pincode) || pincode.length != 6) {
                                addError(
                                  20006,
                                  `value should be a valid range of pincodes (code:"val") for type 11 (intercity) in /bpp/providers[${i}]/tags[${t}]`
                                );
                              }
                            });
                          } else {
                            addError(
                              20006,
                              `serviceability construct /bpp/providers[${i}]/tags[${t}] should be defined as per the API contract (value is missing for code "val")`
                            );
                          }

                          const unit =
                            sc.list.find((elem: any) => elem.code === "unit") ||
                            "";
                          if ("value" in unit) {
                            if (unit.value != "pincode") {
                              addError(
                                20006,
                                `value should be "pincode" (code:"unit") for type 11 (intercity) in /bpp/providers[${i}]/tags[${t}]`
                              );
                            }
                          } else {
                            addError(
                              20006,
                              `serviceability construct /bpp/providers[${i}]/tags[${t}] should be defined as per the API contract (value is missing for code "unit")`
                            );
                          }
                        }
                        break;
                      case "12":
                        {
                          const val =
                            sc.list.find((elem: any) => elem.code === "val") ||
                            "";
                          if ("value" in val) {
                            if (val.value != "IND") {
                              addError(
                                20006,
                                `value should be "IND" (code:"val") for type 12 (PAN India) in /bpp/providers[${i}]tags[${t}]`
                              );
                            }
                          } else {
                            addError(
                              20006,
                              `serviceability construct /bpp/providers[${i}]/tags[${t}] should be defined as per the API contract (value is missing for code "val")`
                            );
                          }

                          const unit =
                            sc.list.find((elem: any) => elem.code === "unit") ||
                            "";
                          if ("value" in unit) {
                            if (unit.value != "country") {
                              addError(
                                20006,
                                `value should be "country" (code:"unit") for type 12 (PAN India) in /bpp/providers[${i}]tags[${t}]`
                              );
                            }
                          } else {
                            addError(
                              20006,
                              `serviceability construct /bpp/providers[${i}]/tags[${t}] should be defined as per the API contract (value is missing for code "unit")`
                            );
                          }
                        }
                        break;
                      default: {
                        addError(
                          20006,
                          `serviceability construct /bpp/providers[${i}]/tags[${t}] should be defined as per the API contract (invalid type "${type.value}")`
                        );
                      }
                    }
                  } else {
                    addError(
                      20006,
                      `serviceability construct /bpp/providers[${i}]/tags[${t}] should be defined as per the API contract (type is missing)`
                    );
                  }
                }
              }
            }
            if (sc.code === "timing") {
              if (timingSet.has(JSON.stringify(sc))) {
                addError(
                  20006,
                  `timing construct /bpp/providers[${i}]/tags[${t}] should not be same with the previous timing constructs`
                );
              }

              timingSet.add(JSON.stringify(sc));
              const fulfillments = prvdr["fulfillments"];
              const fulfillmentTypes = fulfillments.map(
                (fulfillment: any) => fulfillment.type
              );

              let isOrderPresent = false;
              const typeCode = sc?.list.find(
                (item: any) => item.code === "type"
              );
              if (typeCode) {
                const timingType = typeCode.value;
                if (
                  timingType === "Order" ||
                  timingType === "Delivery" ||
                  timingType === "Self-Pickup" ||
                  timingType === "All"
                ) {
                  isOrderPresent = true;
                } else if (!fulfillmentTypes.includes(timingType)) {
                  addError(
                    20006,
                    `The type '${timingType}' in timing tags should match with types in fulfillments array, along with 'Order'`
                  );
                }
              }

              if (!isOrderPresent) {
                addError(20006, `'Order' type must be present in timing tags`);
              }
            }
          });
          if (isEmpty(serviceabilitySet)) {
            addError(
              20006,
              `serviceability construct is mandatory in /bpp/providers[${i}]/tags`
            );
          } else if (serviceabilitySet.size != itemCategory_id.size) {
            addError(
              20006,
              `The number of unique category_id should be equal to count of serviceability in /bpp/providers[${i}]`
            );
          }
          if (isEmpty(timingSet)) {
            addError(
              20006,
              `timing construct is mandatory in /bpp/providers[${i}]/tags`
            );
          } else {
            const timingsPayloadArr = new Array(...timingSet).map((item: any) =>
              JSON.parse(item)
            );
            const timingsAll = _.chain(timingsPayloadArr)
              .filter((payload) =>
                _.some(payload.list, { code: "type", value: "All" })
              )
              .value();

            const timingsOther = _.chain(timingsPayloadArr)
              .filter(
                (payload) =>
                  _.some(payload.list, { code: "type", value: "Order" }) ||
                  _.some(payload.list, { code: "type", value: "Delivery" }) ||
                  _.some(payload.list, { code: "type", value: "Self-Pickup" })
              )
              .value();

            if (timingsAll.length > 0 && timingsOther.length > 0) {
              addError(
                20006,
                `If the timings of type 'All' is provided then timings construct for 'Order'/'Delivery'/'Self-Pickup' is not required`
              );
            }

            const arrTimingTypes = new Set();

            function checkTimingTag(tag: any) {
              const typeObject = tag.list.find(
                (item: { code: string }) => item.code === "type"
              );
              const typeValue = typeObject ? typeObject.value : null;
              arrTimingTypes.add(typeValue);
              for (const item of tag.list) {
                switch (item.code) {
                  case "day_from":
                  case "day_to":
                    const dayValue = parseInt(item.value);
                    if (
                      isNaN(dayValue) ||
                      dayValue < 1 ||
                      dayValue > 7 ||
                      !/^-?\d+(\.\d+)?$/.test(item.value)
                    ) {
                      addError(
                        20006,
                        `Invalid value for '${item.code}': ${item.value}`
                      );
                    }
                    break;
                  case "time_from":
                  case "time_to":
                    if (!/^([01]\d|2[0-3])[0-5]\d$/.test(item.value)) {
                      addError(
                        20006,
                        `Invalid time format for '${item.code}': ${item.value}`
                      );
                    }
                    break;
                  case "location":
                    if (!prvdrLocationIds.has(item.value)) {
                      addError(
                        20006,
                        `Invalid location value as it's unavailable in location/ids`
                      );
                    }
                    break;
                  case "type":
                    break;
                  default:
                    addError(
                      20006,
                      `Invalid list.code for 'timing': ${item.code}`
                    );
                }
              }

              const dayFromItem = tag.list.find(
                (item: any) => item.code === "day_from"
              );
              const dayToItem = tag.list.find(
                (item: any) => item.code === "day_to"
              );
              const timeFromItem = tag.list.find(
                (item: any) => item.code === "time_from"
              );
              const timeToItem = tag.list.find(
                (item: any) => item.code === "time_to"
              );

              if (dayFromItem && dayToItem && timeFromItem && timeToItem) {
                const dayFrom = parseInt(dayFromItem.value, 10);
                const dayTo = parseInt(dayToItem.value, 10);
                const timeFrom = parseInt(timeFromItem.value, 10);
                const timeTo = parseInt(timeToItem.value, 10);

                if (dayTo < dayFrom) {
                  addError(
                    20006,
                    "'day_to' must be greater than or equal to 'day_from'"
                  );
                }

                if (timeTo <= timeFrom) {
                  addError(20006, "'time_to' must be greater than 'time_from'");
                }
              }
            }

            if (timingsAll.length > 0) {
              if (timingsAll.length > 1) {
                addError(
                  20006,
                  `The timings object for 'All' should be provided once!`
                );
              }
              checkTimingTag(timingsAll[0]);
            }

            if (timingsOther.length > 0) {
              timingsOther.forEach((tagTimings: any) => {
                checkTimingTag(tagTimings);
              });
              onSearchFFTypeSet.forEach((type: any) => {
                if (!arrTimingTypes.has(type)) {
                  addError(
                    20006,
                    `The timings object must be present for ${type} in the tags`
                  );
                }
                arrTimingTypes.forEach((type: any) => {
                  if (
                    type != "Order" &&
                    type != "All" &&
                    !onSearchFFTypeSet.has(type)
                  ) {
                    addError(
                      20006,
                      `The timings object ${type} is not present in the onSearch fulfillments`
                    );
                  }
                });
                if (!arrTimingTypes.has("Order")) {
                  addError(
                    20006,
                    `The timings object must be present for Order in the tags`
                  );
                }
              });
            }
          }
        } catch (error: any) {
          console.error(
            `!!Error while checking serviceability and timing construct for bpp/providers[${i}], ${error.stack}`
          );
        }

        try {
          console.info(
            `Checking if catalog_link type in message/catalog/bpp/providers[${i}]/tags[1]/list[0] is link or inline`
          );
          const tags = bppPrvdrs[i].tags;

          let list: any = [];
          tags.map((data: any) => {
            if (data.code == "catalog_link") {
              list = data.list;
            }
          });

          list.map((data: any) => {
            if (data.code === "type") {
              if (data.value === "link") {
                if (bppPrvdrs[0].items) {
                  addError(
                    20006,
                    `Items arrays should not be present in message/catalog/bpp/providers[${i}]`
                  );
                }
              }
            }
          });
        } catch (error: any) {
          console.error(`Error while checking the type of catalog_link`);
        }

        i++;
      }

      await RedisService.setKey(
        `${transaction_id}_onSearchItems`,
        JSON.stringify(itemsArray),
        TTL_IN_SECONDS
      );

      await RedisService.setKey(
        `${transaction_id}_${ApiSequence.ON_SEARCH}prvdrsId`,
        JSON.stringify([...prvdrsId]),
        TTL_IN_SECONDS
      );

      await RedisService.setKey(
        `${transaction_id}_${ApiSequence.ON_SEARCH}prvdrLocId`,
        JSON.stringify([...prvdrLocId]),
        TTL_IN_SECONDS
      );

      await RedisService.setKey(
        `${transaction_id}_${ApiSequence.ON_SEARCH}itemsId`,
        JSON.stringify([...itemsId]),
        TTL_IN_SECONDS
      );
    } catch (error: any) {
      console.error(
        `!!Error while checking Providers info in /${constants.ON_SEARCH}, ${error.stack}`
      );
    }

    try {
      console.info(
        `Checking for errors in default flow in /${constants.ON_SEARCH}`
      );
      const providers = payload.message.catalog["bpp/providers"];

      providers.forEach((provider: any) => {
        let customGroupDetails: any = {};

        provider?.categories.forEach((category: any) => {
          const id: string = category?.id;
          const customGroupTag = category.tags.find(
            (tag: any) =>
              tag.code === "type" &&
              tag.list.some((item: any) => item.value === "custom_group")
          );

          if (customGroupTag) {
            const configTag = category.tags.find(
              (tag: any) => tag.code === "config"
            );
            const min = configTag
              ? parseInt(
                configTag.list.find((item: any) => item.code === "min")
                  ?.value,
                10
              )
              : 0;
            const max = configTag
              ? parseInt(
                configTag.list.find((item: any) => item.code === "max")
                  ?.value,
                10
              )
              : 0;

            if (min > max) {
              addError(
                20006,
                `The "min" (${min}) is more than "max" (${max}) for provider ${provider.id}/categories/${id}`
              );
            }
            customGroupDetails[id] = {
              min: min,
              max: max,
              numberOfDefaults: 0,
              numberOfElements: 0,
            };
          }
        });

        let combinedIds: any = [];

        provider?.items.forEach((item: any) => {
          const typeTag = item.tags.find((tag: any) => tag.code === "type");
          const typeValue = typeTag
            ? typeTag.list.find((listItem: any) => listItem.code === "type")
              ?.value
            : null;

          if (typeValue === "item") {
            const customGroupTags = item.tags.filter(
              (tag: any) => tag.code === "custom_group"
            );
            combinedIds = customGroupTags.flatMap((tag: any) =>
              tag.list.map((listItem: any) => listItem.value)
            );
          } else if (typeValue === "customization") {
            const parentTag = item.tags.find(
              (tag: any) => tag.code === "parent"
            );
            const customizationGroupId = parentTag?.list.find(
              (listItem: any) => listItem.code === "id"
            )?.value;

            if (
              customizationGroupId &&
              customGroupDetails[customizationGroupId]
            ) {
              customGroupDetails[customizationGroupId].numberOfElements += 1;

              const defaultParent = parentTag?.list.find(
                (listItem: any) =>
                  listItem.code === "default" && listItem.value === "yes"
              );
              if (defaultParent) {
                customGroupDetails[customizationGroupId].numberOfDefaults += 1;

                const childTag = item.tags.find(
                  (tag: any) => tag.code === "child"
                );
                if (childTag) {
                  const childIds = childTag.list.map(
                    (listItem: any) => listItem.value
                  );
                  combinedIds = [...combinedIds, ...childIds];
                }
              }
            }
          }
        });

        combinedIds.forEach((id: any) => {
          if (customGroupDetails[id]) {
            const group = customGroupDetails[id];
            const min = group.min;
            const max = group.max;

            if (group.numberOfElements <= max) {
              addError(
                20006,
                `The number of elements (${group.numberOfElements}) in customization group ${provider.id}/categories/${id} is less than or equal to the maximum (${max}) that can be selected`
              );
            }

            if (min > 0 && group.numberOfDefaults < min) {
              addError(
                20006,
                `The number of defaults (${group.numberOfDefaults}) in customization group ${provider.id}/categories/${id} is less than the minimum (${min}) that can be selected`
              );
            }
          }
        });

        const customGroupIds = Object.keys(customGroupDetails);
        customGroupIds.forEach((id) => {
          const group = customGroupDetails[id];
          const max = group.max;

          if (group.numberOfElements < max) {
            addError(
              20006,
              `The number of elements (${group.numberOfElements}) in customization group ${provider.id}/categories/${id} is less than the maximum (${max}) that can be selected`
            );
          }
        });
      });
    } catch (error: any) {
      console.error(
        `Error while checking default flow in /${constants.ON_SEARCH}, ${error.stack}`
      );
      addError(20006, `Error while checking default flow: ${error.message}`);
    }
  } catch (error: any) {
    console.error(
      `Error while storing items of bpp/providers in itemsArray for /${constants.ON_SEARCH}, ${error.stack}`
    );
  }
  return result.length > 0 ? result : [];
}
