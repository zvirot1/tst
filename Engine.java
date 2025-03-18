package com.remainsoftware.chat.core;

import com.remainsoftware.chat.core.events.ChatChangeEvent;
import com.remainsoftware.chat.core.events.ChatPropertyChangeSupport;
import java.beans.PropertyChangeEvent;
import java.beans.PropertyChangeListener;
import java.io.IOException;
import java.net.HttpURLConnection;
import java.net.MalformedURLException;
import java.net.ProtocolException;
import java.net.URL;
import java.text.MessageFormat;
import java.util.HashMap;
import java.util.LinkedList;
import java.util.List;
import java.util.Map;

public final class Engine extends ChatObject implements PropertyChangeListener {
   public static final String DEFAULT_ENDPOINT = "https://api.openai.com/v1/";
   public static String URL_COMPLETIONS = "chat/completions";
   public static String DEFAULT_CHAT_MODEL = "gpt-3.5-turbo";
   private String fApiKey;
   //private Map<String ,String>  customOrganization = new HashMap<String ,String> (); 
   private String fOrganization;
   private List<Response> fResponseHistory = new LinkedList();
   private LinkedList<Chat> fChats = new LinkedList();
   private Exception fLastException;
   private String fChatModelId;
   private String fSystemMessage;
   private ChatPropertyChangeSupport fPropertyChangeSupport = new ChatPropertyChangeSupport(this);
   private static Engine fActiveEngine;
   private String fEndpoint;

   public ChatPropertyChangeSupport getPropertyChangeSupport() {
      return this.fPropertyChangeSupport;
   }

   public Engine(String apiKey, String organization) {
      this.fApiKey = apiKey;
      this.fOrganization = organization;
      this.fChatModelId = DEFAULT_CHAT_MODEL;
      //this.customOrganization = customOrganization;
      this.fPropertyChangeSupport.addPropertyChangeListener(this);
      fActiveEngine = this;
   }

   public static Engine getActiveEngine() {
      return fActiveEngine;
   }

   public void setSystemMessage(String pSystemMessage) {
      this.fSystemMessage = pSystemMessage;
      this.fChats.forEach((chat) -> {
         if (chat.getChatOptions().getSystemMessage() == null) {
            chat.getChatOptions().setSystemMessage(pSystemMessage);
         }

      });
   }

   public String getSystemMessage() {
      if (this.fSystemMessage == null) {
         this.fSystemMessage = "You are an IBM i and AS/400 developer and administrator. You answer questions briefly but to the point. Your answers about RPG are in free format. You know about DB/2 for AS/400 and System i, and SQL.";
      }

      return this.fSystemMessage + " Your name is \"Remain Chat\".";
   }

   public Engine setChatModelId(String pChatModelId) {
      this.fChatModelId = pChatModelId;
      return this;
   }

   public String getChatModelId() {
      return this.fChatModelId;
   }

   public Response getLastResponse() {
      return this.fResponseHistory.isEmpty() ? null : (Response)this.fResponseHistory.get(this.fResponseHistory.size() - 1);
   }

   public Exception getLastException() {
      return this.fLastException;
   }

   public void propertyChange(PropertyChangeEvent pEvent) {
      ChatLog.logInfo(this.getClass(), MessageFormat.format("Event with property {0} received by Engine.", pEvent.getPropertyName()));
   }

   public Chat createChat() {
      Chat chat = new Chat(this, DEFAULT_CHAT_MODEL);
      this.fChats.add(chat);
      this.getPropertyChangeSupport().firePropertyChange(new ChatChangeEvent(this, "chat.created", (Chat)null, chat));
      return chat;
   }

   HttpURLConnection getConnection(String pMethod, String pURL) throws IOException, MalformedURLException, ProtocolException {
      HttpURLConnection con = (HttpURLConnection)(new URL(pURL)).openConnection();
      con.setRequestMethod(pMethod);
      con.setRequestProperty("Content-Type", "application/json");
      con.setRequestProperty("Authorization", "Bearer " + this.fApiKey);
      if (System.getProperty("CustomHeaderKey") != null && System.getProperty("CustomHeaderValue") != null) {
		 con.setRequestProperty(System.getProperty("CustomHeaderKey"), System.getProperty("CustomHeaderValue"));
	  }
      
      
      if (this.fOrganization != null && !this.fOrganization.isEmpty()) {
         con.setRequestProperty("OpenAI-Organization", this.fOrganization);
      }

      return con;
   }

   public LinkedList<Chat> getChats() {
      return this.fChats;
   }

   public String getDescription() {
      return this.getSystemMessage();
   }

   public Chat[] getChildren() {
      return (Chat[])this.getChats().toArray(new Chat[0]);
   }

   public ChatObject getParent() {
      return null;
   }

   public void setEndPoint(String pEndpoint) {
      this.fEndpoint = pEndpoint;
   }

   public String getEndpoint(String pPath) {
      return this.fEndpoint.endsWith("/") ? this.fEndpoint.trim() + pPath.trim() : this.fEndpoint.trim() + "/" + pPath.trim();
   }
}
